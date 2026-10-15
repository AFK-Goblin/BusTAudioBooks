const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { app } = require('../src/index');
const tb = require('../src/torbox');
const ad = require('../src/alldebrid');
const { encodeConfig } = require('../src/config');
const { encodeItemId } = require('../src/itemid');
function get(server, path) {
  return new Promise((resolve,reject)=>http.get({hostname:'127.0.0.1',port:server.address().port,path},res=>{
    let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text,headers:res.headers}));
  }).on('error',reject));
}
test('companion install link, health, chapter streams and legacy TorBox remain compatible',async t=>{
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  t.mock.method(ad,'validateKey',async()=>true);
  t.mock.method(tb,'validateKey',async()=>true);
  let adCalls=0,tbCalls=0;
  let deferred=false;
  const result=()=>({ready:true,status:'ok',streams:[{title:'Chapter',...(deferred ? {debridLink:'https://alldebrid.com/f/chapter'} : {url:'https://audio/'+adCalls}),behaviorHints:{filename:'La.Roue.Du.Temps.Tome14/01 - Prologue - 1.mp3'}}]});
  t.mock.method(ad,'resolveStreams',async(_key,item)=>{adCalls++;deferred=item.deferUnlock;return result();});
  t.mock.method(tb,'resolveStreams',async()=>{tbCalls++;deferred=false;return result();});
  const cfg=encodeConfig({provider:'alldebrid',apiKey:'ad-key'});
  const old=encodeConfig({apiKey:'tb-key'});
  const id=encodeItemId({name:'Livre',infohash:'a'.repeat(40)});
  const health=JSON.parse((await get(server,`/${cfg}/health`)).text);
  assert.equal(health.provider,'alldebrid');assert.equal(health.providerKeyValid,true);assert.equal(health.torboxKeyValid,true);
  const first=JSON.parse((await get(server,`/${cfg}/app/streams/${id}`)).text);
  const fresh=JSON.parse((await get(server,`/${cfg}/app/streams/${id}`)).text);
  assert.equal(first.streams[0].filename,'La.Roue.Du.Temps.Tome14/01 - Prologue - 1.mp3');assert.equal(first.streams[0].title,'01 - Prologue - 1.mp3');assert.equal(first.streams[0].url,fresh.streams[0].url);assert.match(first.streams[0].url,/app\/audio\//);
  t.mock.method(ad,'unlockLink',async(key,link)=>{assert.equal(key,'ad-key');assert.equal(link,'https://alldebrid.com/f/chapter');return 'https://cdn.example/audio.mp3';});
  const audio=await get(server,new URL(first.streams[0].url).pathname);
  assert.equal(audio.status,302);assert.equal(audio.headers.location,'https://cdn.example/audio.mp3');
  await get(server,`/${old}/app/streams/${id}`);assert.equal(tbCalls,1);assert.equal(adCalls,2);
  assert.equal(JSON.parse((await get(server,`/${old}/manifest.json`)).text).id,'community.torbox.audiobooks');
  const invalid=encodeConfig({provider:'wrong',apiKey:'key'});
  assert.equal((await get(server,`/${invalid}/health`)).status,400);
  const page=(await get(server,'/configure')).text;
  const scripts=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  scripts.forEach(s=>new vm.Script(s));
  const nodes = {};
  const node = id => nodes[id] ||= { value:'', checked:false, hidden:true, style:{},
    setAttribute(){}, focus(){}, querySelectorAll(){ return []; } };
  const alerts = [];
  const context = vm.createContext({ window:{}, document:{getElementById:node},
    location:{origin:'http://localhost:7000'}, alert:message=>alerts.push(message),
    btoa:value=>Buffer.from(value,'binary').toString('base64'), unescape, encodeURIComponent });
  scripts.forEach(script=>vm.runInContext(script,context));
  assert.match(node('abbHelp').textContent,/Leave blank to use it/);
  node('languageFilter').value='fr';
  node('apiKey').value='service-key'; node('provider').value='alldebrid';
  node('c411ApiKey').value='private-tracker-key'; node('c411Enabled').checked=true;
  const generated = () => JSON.parse(Buffer.from(new URL(node('url').value).pathname.split('/')[1], 'base64url'));
  vm.runInContext('gen()',context);
  assert.equal(generated().c411ApiKey,undefined);assert.equal(generated().languageFilter,'fr');
  node('frenchEnabled').checked=true;
  vm.runInContext('toggleFrench(); gen()',context);
  assert.equal(node('frenchSettings').hidden,false);
  assert.equal(node('c411Settings').hidden,false);
  assert.equal(generated().c411ApiKey,'private-tracker-key');
  node('c411Enabled').checked=false;
  vm.runInContext('toggleTracker("c411"); gen()',context);
  assert.equal(node('c411Settings').hidden,true);
  assert.equal(generated().c411ApiKey,undefined);
  node('c411Enabled').checked=true;node('c411ApiKey').value='';
  vm.runInContext('gen()',context);
  assert.equal(alerts.length,1);
  context.window.__abbDomain='default.example';
  vm.runInContext(scripts[scripts.length-1],context);
  assert.match(node('abbLabel').textContent,/override/);
  assert.match(node('abbHelp').textContent,/default.example/);
  assert.equal(node('abbDomain').value,'');
  assert.match(page,/c411ApiKey/);assert.match(page,/AllDebrid/);
});
test('TorBox preserves private torrent files even when the result includes an infohash',async t=>{
  let fetched=0;
  const source=http.createServer((_req,res)=>{fetched++;res.end('d4:infod4:name4:bookee');});
  source.listen(0,'127.0.0.1');await new Promise(r=>source.once('listening',r));t.after(()=>source.close());
  t.mock.method(global,'fetch',async(url,opts)=>{
    if(String(url).includes('createtorrent')) {
      assert.ok(opts.body.get('file'));assert.equal(opts.body.get('magnet'),null);
      return {json:async()=>({success:true,data:{torrent_id:1}})};
    }
    return {json:async()=>({success:true,data:[]})};
  });
  await tb.resolveStreams('key',{infohash:'a'.repeat(40),torrentUrl:`http://127.0.0.1:${source.address().port}/file`});
  assert.equal(fetched,1);
});
test('search cache cannot share private tracker links between accounts',async t=>{
  const {runSearch}=require('../src/index');
  t.mock.method(ad,'checkCachedMany',async()=>new Set());
  t.mock.method(global,'fetch',async value=>{
    const url=new URL(value);
    if(url.hostname==='api.torr9.net') {
      const key=url.searchParams.get('apikey');
      return {ok:true,text:async()=>`<rss><channel><item><title>Émile ${key}</title><enclosure url="https://tracker/file?key=${key}"/></item></channel></rss>`};
    }
    return {ok:true,json:async()=>({}),text:async()=>'<html></html>'};
  });
  const a=await runSearch({provider:'alldebrid',apiKey:'shared',torr9Passkey:'first'},'unique-cache-test',1);
  const b=await runSearch({provider:'alldebrid',apiKey:'shared',torr9Passkey:'second'},'unique-cache-test',1);
  assert.equal(a[0].torrentUrl,'https://tracker/file?key=first');assert.equal(b[0].torrentUrl,'https://tracker/file?key=second');
});

test('French-first ranking runs before the result cap and the app receives readable titles',async t=>{
  const {runSearch}=require('../src/index');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  t.mock.method(tb,'checkCachedMany',async()=>new Set());
  const results=Array.from({length:40},(_,i)=>({Title:`Book ${i} [ENGLISH]`,InfoHash:i.toString(16).padStart(40,'0'),Seeders:1000-i}));
  results.push({Title:'Un.Livre.Français.[FRENCH].[MP3]',InfoHash:'f'.repeat(40),Seeders:1});
  t.mock.method(global,'fetch',async input=>{
    const url=new URL(input);
    if(url.hostname==='jackett.test') return {ok:true,json:async()=>({Results:results})};
    return {ok:true,text:async()=>'<html></html>',json:async()=>({})};
  });
  const cfg={apiKey:'ranking',jackettUrl:'http://jackett.test',jackettApiKey:'search',preferredLanguage:'fr'};
  const ranked=await runSearch(cfg,'ranking-test',1);
  assert.equal(ranked.length,40);assert.equal(ranked[0].infohash,'f'.repeat(40));
  const response=JSON.parse((await get(server,`/${encodeConfig(cfg)}/app/search?q=ranking-test`)).text);
  assert.equal(response.results[0].title,'Un Livre Français');assert.equal(response.results[0].language,'fr');
  assert.equal(response.results[0].releaseName,'Un.Livre.Français.[FRENCH].[MP3]');
  const english=await runSearch({...cfg,preferredLanguage:'en'},'ranking-test',1);
  assert.match(english[0].name,/ENGLISH/);
});
test('a slow metadata batch keeps completed covers and fills cached results later',async t=>{
  const {runSearch}=require('../src/index');
  const { _metaCache }=require('../src/metadata');_metaCache.m.clear();
  const names=['Couverture Réussie',...Array.from({length:6},(_,i)=>`Livre Lent ${i}`)];
  t.mock.method(global,'fetch',async(input,opts={})=>{
    const url=new URL(input);
    if(url.hostname==='jackett.test') return {ok:true,json:async()=>({Results:names.map((Title,i)=>({Title,Link:`https://tracker/${i}`}))})};
    if(url.hostname==='itunes.apple.com'||url.hostname==='www.googleapis.com'||url.hostname==='openlibrary.org') {
      if((url.searchParams.get('term')||url.searchParams.get('q')).includes('Couverture')) {
        return {ok:true,json:async()=>({results:[{collectionName:'Couverture Réussie',artworkUrl100:'https://cover/100x100bb.jpg'}]})};
      }
      return new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));
    }
    return {ok:true,text:async()=>'<html></html>',json:async()=>({})};
  });
  const cfg={apiKey:'slow-batch',jackettUrl:'http://jackett.test',jackettApiKey:'slow'};
  const items=await runSearch(cfg,'partial-cover-test',1);
  assert.equal(items[0].poster,'https://cover/600x600bb.jpg');
  assert.equal(items.length,7);
  // Drain queued background lookups before restoring the network mock.
  await new Promise(resolve=>setTimeout(resolve,1800));
  const cached=await runSearch(cfg,'partial-cover-test',1);
  assert.equal(cached[0].poster,'https://cover/600x600bb.jpg');
});

test('exclusive language filtering happens before capping and keeps legacy preference behavior',async t=>{
  const {runSearch}=require('../src/index');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  t.mock.method(tb,'checkCachedMany',async()=>new Set());
  const results=Array.from({length:40},(_,i)=>({Title:`English book ${i} [ENGLISH]`,InfoHash:i.toString(16).padStart(40,'0'),Seeders:1000-i}));
  results.push({Title:'La Révolte de la Reine [FRENCH]',InfoHash:'f'.repeat(40),Seeders:1});
  results.push({Title:'Unlabelled book',InfoHash:'e'.repeat(40),Tracker:'C411',Seeders:100});
  results.push({Title:'Unlabelled ABB book',InfoHash:'d'.repeat(40),Tracker:'AudiobookBay',Seeders:200});
  t.mock.method(global,'fetch',async input=>{
    const url=new URL(input);
    if(url.hostname==='language-filter.test') return {ok:true,json:async()=>({Results:results})};
    return {ok:true,text:async()=>'<html></html>',json:async()=>({})};
  });
  const cfg={apiKey:'exclusive',jackettUrl:'http://language-filter.test',jackettApiKey:'search',languageFilter:'fr'};
  const french=JSON.parse((await get(server,`/${encodeConfig(cfg)}/app/search?q=filter-test`)).text);
  assert.equal(french.results.length,2);assert.ok(french.results.every(item=>item.language==='fr'));
  assert.ok(french.results.some(item=>item.releaseName==='Unlabelled book'));
  assert.ok(!french.results.some(item=>item.releaseName==='Unlabelled ABB book'));
  const english=await runSearch({...cfg,languageFilter:'en'},'filter-test',1);
  assert.equal(english.length,40);assert.ok(english.every(item=>item.name.includes('ENGLISH')));
  const legacy=await runSearch({...cfg,languageFilter:undefined,preferredLanguage:'fr'},'filter-test',1);
  assert.ok(legacy.some(item=>item.name.includes('ENGLISH')));
});
