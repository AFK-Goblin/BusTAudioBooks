const test = require('node:test');
const assert = require('node:assert/strict');
const tb = require('../src/torbox');
const ad = require('../src/alldebrid');
const french = require('../src/french-trackers');
const { providerFor } = require('../src/providers');
const { encodeItemId, decodeItemId } = require('../src/itemid');
const hash = 'a'.repeat(40);
const xml = `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>Écouter &amp; rêver [MP3]</title><guid>https://tracker/book/1</guid><enclosure url="https://tracker/download?key=secret&amp;id=1" length="123"/><torznab:attr name="infohash" value="${hash}"/><torznab:attr name="seeders" value="5"/></item></channel></rss>`;
const response = data => ({ ok: true, json: async () => ({ status: 'success', data }) });
test('legacy configuration selects TorBox; provider selection is explicit', () => {
  assert.equal(providerFor({}), tb); assert.equal(providerFor({ provider: 'alldebrid' }), ad);
  assert.throws(() => providerFor({ provider: 'typo' }));
});
test('French XML preserves Unicode and private links through item IDs', () => {
  const [item] = french._parse(xml, 'C411');
  assert.equal(item.name, 'Écouter & rêver [MP3]'); assert.equal(item.infohash, hash);
  assert.equal(item.seeders, 5); assert.equal(item.size, 123);
  assert.equal(decodeItemId(encodeItemId(item)).torrentUrl, 'https://tracker/download?key=secret&id=1');
  const noHash = french._parse(xml.replace(`<torznab:attr name="infohash" value="${hash}"/>`, ''), 'Torr9')[0];
  assert.equal(noHash.infohash, null); assert.ok(noHash.torrentUrl);
  assert.throws(() => french._parse('<html>Login</html>', 'C411'));
  assert.throws(() => french._parse('<error code="100"/>', 'C411'));
});
test('Frenchio-style JSON singleton items and attrs are accepted', () => {
  const [item] = french._parse(JSON.stringify({channel:{item:{title:'Livre', 'torznab:attr':{'@attributes':{name:'infohash',value:hash}},enclosure:{'@attributes':{url:'https://tracker/torrent'}}}}}), 'C411');
  assert.equal(item.infohash,hash); assert.equal(item.torrentUrl,'https://tracker/torrent');
});
test('direct tracker search uses audiobook category and pagination without debrid calls', async t => {
  t.mock.method(global, 'fetch', async url => {
    assert.equal(url.searchParams.get('cat'), '3030'); assert.equal(url.searchParams.get('t'), 'search');
    assert.equal(url.searchParams.get('q'), 'Émile Zola'); assert.equal(url.searchParams.get('offset'), '40');
    return {ok:true,text:async()=>xml};
  });
  assert.equal((await french.searchTracker('c411',{c411ApiKey:'key'},'Émile Zola',2)).length,1);
});
test('AllDebrid search cache check is read-only and account scoped', async t => {
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.ok(url.endsWith('/v4.1/magnet/status')); assert.equal(opts.headers.Authorization,'Bearer key');
    return response({magnets:[{id:1,hash,statusCode:4},{id:2,hash:'b'.repeat(40),statusCode:1}]});
  });
  assert.deepEqual([...await ad.checkCachedMany('key',[hash,'b'.repeat(40)])],[hash]);
});
test('AllDebrid resolves every nested audio file in natural order; refresh unlocks again', async t => {
  let unlocks=0;
  t.mock.method(global, 'fetch', async (url, opts) => {
    if(url.endsWith('/magnet/status')) return response({magnets:[{id:42,hash,statusCode:4}]});
    if(url.endsWith('/magnet/files')) return response({magnets:[{id:42,files:[{n:'Disc 1',e:[{n:'10.mp3',l:'https://alldebrid.com/f/ten'},{n:'2.mp3',l:'https://alldebrid.com/f/two'},{n:'cover.jpg',l:'image'}]}]}]});
    assert.ok(url.endsWith('/link/unlock')); unlocks++; return response({link:'https://audio/'+opts.body.get('link')+'/'+unlocks});
  });
  const item={infohash:hash};
  const a=await ad.resolveStreams('key',item); const b=await ad.resolveStreams('key',item);
  assert.deepEqual(a.streams.map(s=>s.behaviorHints.filename),['Disc 1/2.mp3','Disc 1/10.mp3']);
  assert.equal(a.ready,true); assert.notEqual(a.streams[0].url,b.streams[0].url); assert.equal(unlocks,4);
});
test('AllDebrid uploads authenticated torrent bytes even when a hash is present', async t => {
  t.mock.method(tb,'fetchTorrentSource',async url=>{assert.equal(url,'https://tracker/private');return {buffer:Buffer.from('torrent')};});
  let uploaded=false;
  t.mock.method(global,'fetch',async (url,opts)=>{
    if(url.endsWith('/magnet/upload/file')) {assert.ok(opts.body.get('files[]'));uploaded=true;return response({files:[{id:7}]});}
    assert.ok(url.endsWith('/magnet/status'));
    return response({magnets:uploaded?[{id:7,hash,statusCode:1}]:[]});
  });
  const result=await ad.resolveStreams('private-key',{infohash:hash,torrentUrl:'https://tracker/private'});
  assert.equal(uploaded,true); assert.equal(result.ready,false);
});
test('account-ready-only never uploads uncached books', async t => {
  t.mock.method(global,'fetch',async url=>{assert.ok(url.endsWith('/magnet/status'));return response({magnets:[]});});
  const r=await ad.resolveStreams('no-upload',{infohash:hash,instantOnly:true}); assert.equal(r.ready,false);
});
test('AllDebrid surfaces API errors and never silently drops failed chapters', async t => {
  t.mock.method(global,'fetch',async url=> {
    if(url.endsWith('/magnet/status')) return response({magnets:[{id:42,hash,statusCode:4}]});
    if(url.endsWith('/magnet/files')) return response({magnets:[{id:42,files:[{n:'01.mp3',l:'https://alldebrid.com/f/x'}]}]});
    return {ok:false,json:async()=>({status:'error',error:{code:'LINK_DOWN',message:'secret'}})};
  });
  await assert.rejects(ad.resolveStreams('error-key',{infohash:hash}),/LINK_DOWN/);
});
test('large AllDebrid chapter queues defer unlock until the app requests a file', async t => {
  const files=Array.from({length:500},(_,i)=>({n:`${i+1}.mp3`,l:`https://alldebrid.com/f/${i}`}));
  t.mock.method(global,'fetch',async url=>{
    if(url.endsWith('/magnet/status')) return response({magnets:[{id:99,hash,statusCode:4}]});
    assert.ok(url.endsWith('/magnet/files')); return response({magnets:[{id:99,files}]});
  });
  const r=await ad.resolveStreams('large',{infohash:hash,deferUnlock:true});
  assert.equal(r.streams.length,500);assert.equal(r.streams[0].debridLink,'https://alldebrid.com/f/0');
  assert.equal(r.streams[0].url,undefined);
});
test('AllDebrid file redirect rejects arbitrary external links',async()=>{
  await assert.rejects(ad.unlockLink('key','https://attacker.invalid/f/x'),/Invalid AllDebrid/);
});
