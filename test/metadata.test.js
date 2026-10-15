const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNameParts, enrich, _metaCache, _matchScore } = require('../src/metadata');
const { chapterTitle } = require('../src/presentation');
const { matchesLanguageFilter, preferredLanguage, releaseLanguage, languageScore } = require('../src/language');

test('chapter display strips torrent folders and keeps the real audio filename', () => {
  assert.equal(chapterTitle('La.Roue.Du.Temps.Tome14/Disc 1/01 - Prologue - 1.mp3'), '01 - Prologue - 1.mp3');
  assert.equal(chapterTitle('Torrent\\Disc 2\\02 - Chapitre.mp3'), '02 - Chapitre.mp3');
  assert.equal(chapterTitle('01.mp3'), '01.mp3');
});
test('French release names become readable metadata queries without losing volume identity', () => {
  assert.equal(parseNameParts('La.Roue.Du.Temps.Tome14.Un.souvenir.de.lumière.FRENCH.[MP3].[128kbps]').title,
    'La Roue Du Temps Tome 14 Un souvenir de lumière');
  assert.equal(parseNameParts('L’Étranger - Albert Camus [FRENCH] [MP3]').author, 'Albert Camus');
  assert.equal(parseNameParts('Digital Minimalism - Cal Newport').title, 'Digital Minimalism');
  assert.equal(parseNameParts('Un.Livre.Français.[FRENCH].[MP3]').title, 'Un Livre Français');
  assert.equal(parseNameParts('The English Patient [MP3]').title, 'The English Patient');
  assert.match(parseNameParts('Série Tome 1.5 [M4B]').title, /1\.5/);
});
test('language preference defaults only French tracker installs to French first', () => {
  assert.equal(preferredLanguage({}), null);
  assert.equal(preferredLanguage({c411ApiKey:'key'}), 'fr');
  assert.equal(preferredLanguage({c411ApiKey:'key',preferredLanguage:'any'}), null);
  assert.equal(preferredLanguage({preferredLanguage:'en',c411ApiKey:'key'}), 'en');
  assert.equal(releaseLanguage({name:'En attendant Bojangles'}), null);
  assert.equal(releaseLanguage({name:'Un livre en français'}), 'fr');
  assert.equal(releaseLanguage({name:'Book [EN]'}), 'en');
  assert.equal(releaseLanguage({name:'Book',language:'fr-FR'}), 'fr');
  assert.ok(languageScore({name:'Book FRENCH'},'fr') === languageScore({tracker:'C411'},'fr'));
  assert.ok(languageScore({tracker:'C411'},'fr') > languageScore({tracker:'C411',name:'Book ENGLISH'},'fr'));
});
test('metadata requests use French storefront/language and return matched title, author and cover', async t => {
  _metaCache.m.clear();
  const requests=[];
  t.mock.method(global,'fetch',async input=>{
    const url=new URL(input);requests.push(url);
    const body=url.hostname==='itunes.apple.com' ? {results:[
      {collectionName:'A completely unrelated book',artistName:'Wrong',artworkUrl100:'https://wrong/100x100bb.jpg'},
      {collectionName:'Un souvenir de lumière (La Roue du Temps, Tome 14)',artistName:'Robert Jordan',artworkUrl100:'https://cover/100x100bb.jpg'}
    ]} : {};
    return {ok:true,json:async()=>body};
  });
  const meta=await enrich('La.Roue.Du.Temps.Tome14.Un.souvenir.de.lumière.FRENCH.[MP3]','audiobook','fr');
  assert.equal(meta.title,'Un souvenir de lumière (La Roue du Temps, Tome 14)');
  assert.equal(meta.author,'Robert Jordan');assert.equal(meta.poster,'https://cover/600x600bb.jpg');
  const apple=requests.find(u=>u.hostname==='itunes.apple.com');
  assert.equal(apple.searchParams.get('country'),'FR');assert.ok(!apple.searchParams.get('term').includes('.'));
  assert.equal(requests.find(u=>u.hostname==='www.googleapis.com').searchParams.get('langRestrict'),'fr');
  assert.equal(requests.find(u=>u.hostname==='openlibrary.org').searchParams.get('lang'),'fr');
  assert.ok(!requests.find(u=>u.hostname==='www.googleapis.com').searchParams.has('country'));
});
test('metadata caches do not mix locales and unrelated matches never replace a book title', async t => {
  _metaCache.m.clear();let calls=0;
  t.mock.method(global,'fetch',async()=>{calls++;return {ok:true,json:async()=>({results:[{collectionName:'Wrong title',artistName:'Wrong',artworkUrl100:'https://wrong'}]})};});
  const fallback=await enrich('Une.Histoire.Inconnue.[MP3]','audiobook','fr');
  assert.equal(fallback.title,'Une Histoire Inconnue');assert.equal(fallback.poster,null);
  await enrich('Une.Histoire.Inconnue.[MP3]','audiobook','fr');assert.equal(calls,3);
  await enrich('Une.Histoire.Inconnue.[MP3]','audiobook','en');assert.equal(calls,6);
  assert.equal(_matchScore('Series Tome 14','Series Tome 13'),0);
});
test('the reported Harry Potter release removes NOTAG and separates author initials', () => {
  assert.deepEqual(parseNameParts('Harry Potter JK Rowling -NOTAG'), {title:'Harry Potter',author:'JK Rowling'});
  assert.deepEqual(parseNameParts('Harry.Potter.J.K.Rowling-NOTAG'), {title:'Harry Potter',author:'J K Rowling'});
  assert.deepEqual(parseNameParts('J.K.Rowling - Harry Potter à l’école des sorciers [MP3]'), {title:'Harry Potter à l’école des sorciers',author:'J K Rowling'});
  assert.equal(_matchScore('Harry Potter', 'Harry Potter à l’école des sorciers de J. K. Rowling (Analyse de l’œuvre)'), 0);
});
test('Harry Potter gets a cover when Google is quota-limited and Open Library returns an author-bearing match', async t => {
  _metaCache.m.clear();
  t.mock.method(global,'fetch',async input=>{
    const url=new URL(input);
    assert.ok(!(url.searchParams.get('term')||url.searchParams.get('q')).includes('NOTAG'));
    assert.match(url.searchParams.get('term')||url.searchParams.get('q'),/J K Rowling/);
    if(url.hostname==='itunes.apple.com') return {ok:true,json:async()=>({results:[]})};
    if(url.hostname==='www.googleapis.com') return {ok:false,status:429,json:async()=>({error:{message:'Quota exceeded'}})};
    return {ok:true,json:async()=>({docs:[{title:"Harry Potter à l'école des sorciers",author_name:['J.K. Rowling'],cover_i:12345}]})};
  });
  const meta=await enrich('Harry Potter JK Rowling -NOTAG','audiobook','fr');
  assert.equal(meta.poster,'https://covers.openlibrary.org/b/id/12345-L.jpg');
  assert.equal(meta.title,'Harry Potter');
  assert.equal(meta.author,'J.K. Rowling');
});
test('catalog matching accounts for authors without selecting study guides', async t => {
  _metaCache.m.clear();
  t.mock.method(global,'fetch',async input=>{
    if(new URL(input).hostname!=='itunes.apple.com') return {ok:true,json:async()=>({})};
    return {ok:true,json:async()=>({results:[
      {collectionName:"Harry Potter à l'école des sorciers (Analyse de l'oeuvre)",artistName:'lePetitLitteraire',artworkUrl100:'https://wrong/100x100bb.jpg'},
      {collectionName:"Harry Potter à l'école des sorciers",artistName:'J.K. Rowling',artworkUrl100:'https://right/100x100bb.jpg'},
    ]})};
  });
  const meta=await enrich('J.K.Rowling - Harry Potter à l’école des sorciers [MP3]','audiobook','fr');
  assert.equal(meta.poster,'https://right/600x600bb.jpg');
  assert.equal(meta.author,'J.K. Rowling');
});

test('French volume and year release markers do not constrain catalog queries', async t => {
  _metaCache.m.clear();
  const raw='Inheritance T01 La Revolte De La Reine Morgane Moncomble 2026';
  assert.equal(parseNameParts(raw).title,'Inheritance Tome 1 La Revolte De La Reine Morgane Moncomble');
  assert.equal(parseNameParts('1984').title,'1984');
  assert.equal(parseNameParts('Inheritance T01 La Revolte De La Reine Morgane Moncomble 2026 MP3').title,parseNameParts(raw).title);
  assert.equal(_matchScore('Inheritance Tome 1 La Revolte De La Reine','Inheritance Tome 2 La Revolte De La Reine'),0);
  t.mock.method(global,'fetch',async input=>{
    const url=new URL(input);
    const query=url.searchParams.get('term')||url.searchParams.get('q');
    assert.ok(!/T01|Tome\s*1|2026/i.test(query));
    if(url.hostname!=='itunes.apple.com') return {ok:true,json:async()=>({})};
    return {ok:true,json:async()=>({results:[{collectionName:'La Révolte de la Reine',artistName:'Morgane Moncomble & Hugo Publishing',artworkUrl100:'https://cover/100x100bb.jpg'}]})};
  });
  const meta=await enrich(raw,'audiobook','fr');
  assert.equal(meta.title,'La Révolte de la Reine');
  assert.equal(meta.poster,'https://cover/600x600bb.jpg');
});
test('exclusive language filters default French trackers to French and require explicit AudiobookBay language',()=>{
  const cfg={languageFilter:'fr',c411ApiKey:'key'};
  assert.equal(preferredLanguage(cfg),'fr');
  assert.equal(matchesLanguageFilter({name:'Book FRENCH'},cfg),true);
  assert.equal(matchesLanguageFilter({name:'Book',language:'fr-FR'},cfg),true);
  assert.equal(matchesLanguageFilter({name:'Book ENGLISH',tracker:'C411'},cfg),false);
  assert.equal(matchesLanguageFilter({name:'Un titre inconnu',tracker:'C411'},cfg),true);
  assert.equal(matchesLanguageFilter({name:'Inheritance T01 La Revolte De La Reine',tracker:'C411'},cfg),true);
  for (const tracker of ['C411','Tr4ker','Torr9']) {
    assert.equal(releaseLanguage({name:'Unlabelled book',tracker}),'fr');
    assert.equal(matchesLanguageFilter({name:'Unlabelled book',tracker},cfg),true);
    assert.equal(matchesLanguageFilter({name:'Book ENGLISH',tracker},cfg),false);
    assert.equal(matchesLanguageFilter({name:'Book',tracker,language:'en'},cfg),false);
    assert.equal(matchesLanguageFilter({name:'Unlabelled book',tracker},{languageFilter:'en'}),false);
  }
  assert.equal(releaseLanguage({name:'La Révolte de la Reine',tracker:'AudiobookBay'}),null);
  assert.equal(matchesLanguageFilter({name:'La Révolte de la Reine',tracker:'AudiobookBay'},cfg),false);
  assert.equal(matchesLanguageFilter({name:'Book',tracker:'AudiobookBay',language:'French'},cfg),true);
  assert.equal(matchesLanguageFilter({name:'Book [FRENCH]',tracker:'AudiobookBay'},cfg),true);
  assert.equal(matchesLanguageFilter({name:'Book',tracker:'AudiobookBay',language:'English'},cfg),false);
  assert.equal(matchesLanguageFilter({name:'Book [FRENCH]',language:'de'},cfg),false);
  assert.equal(matchesLanguageFilter({name:'Book MULTI FRENCH ENGLISH'},cfg),false);
  assert.equal(matchesLanguageFilter({name:'Book MULTI FRENCH'},cfg),false);
  assert.equal(matchesLanguageFilter({name:'Book FRENCH',language:'fr,en'},cfg),false);
  assert.equal(matchesLanguageFilter({name:'Book [EN]'},{languageFilter:'en'}),true);
  assert.equal(matchesLanguageFilter({name:'Book ENGLISH'},{preferredLanguage:'fr'}),true);
  assert.equal(matchesLanguageFilter({name:'Book'},{}),true);
});
test('release-group suffixes after language or format tags do not pollute book metadata', () => {
  assert.deepEqual(parseNameParts('Code Ardant Marge Nantel FR -PiXeL'), {title:'Code Ardant Marge Nantel',author:null});
  assert.equal(parseNameParts('Code Ardant Marge Nantel [MP3]-DifferentGroup').title,'Code Ardant Marge Nantel');
  assert.deepEqual(parseNameParts('Dune - Frank Herbert [MP3]'),{title:'Dune',author:'Frank Herbert'});
  assert.equal(parseNameParts('Twenty-One Days [MP3]').title,'Twenty-One Days');
});
test('complete title plus release author matches an audio drama credited to its cast', async t => {
  _metaCache.m.clear();
  t.mock.method(global,'fetch',async input=>{
    const url=new URL(input);
    assert.ok(!/PiXeL|\bFR\b/.test(url.searchParams.get('term')||url.searchParams.get('q')));
    if(url.hostname!=='itunes.apple.com') return {ok:true,json:async()=>({})};
    return {ok:true,json:async()=>({results:[
      {collectionName:'Ardant',artistName:'Marge Nantel',artworkUrl100:'https://wrong/100x100bb.jpg'},
      {collectionName:'Code Ardant',artistName:'BLYND',artworkUrl100:'https://right/100x100bb.jpg'},
    ]})};
  });
  const meta=await enrich('Code Ardant Marge Nantel FR -PiXeL','audiobook','fr');
  assert.equal(meta.title,'Code Ardant');assert.equal(meta.poster,'https://right/600x600bb.jpg');
});
test('split compound words and punctuation normalize for catalog queries and matching', async t => {
  _metaCache.m.clear();
  assert.equal(_matchScore('hyper sensible','hypersensible'),1);
  assert.equal(_matchScore('hyper-sensible','hypersensible'),1);
  assert.equal(_matchScore('hypo sensible','hypersensible'),0);
  const raw='Suis je hyper sensible ? Fabrice Midal';
  assert.equal(parseNameParts(raw).title,raw);
  t.mock.method(global,'fetch',async input=>{
    const url=new URL(input);const query=url.searchParams.get('term')||url.searchParams.get('q');
    assert.equal(query,'Suis je hypersensible Fabrice Midal');
    if(url.hostname!=='itunes.apple.com') return {ok:true,json:async()=>({})};
    return {ok:true,json:async()=>({results:[{
      collectionName:'Suis-je hypersensible ? Enquête sur un pouvoir méconnu',artistName:'Fabrice Midal',artworkUrl100:'https://cover/100x100bb.jpg',
    }]})};
  });
  const meta=await enrich(raw,'audiobook','fr');
  assert.equal(meta.poster,'https://cover/600x600bb.jpg');assert.equal(meta.author,'Fabrice Midal');
});
test('language-edition labels glued to an author do not pollute catalog queries', async t => {
  _metaCache.m.clear();
  const raw='Impact Winter Tome 2 French EditionTravis Beacham FR -PiXeL';
  assert.deepEqual(parseNameParts(raw),{title:'Impact Winter Tome 2 Travis Beacham',author:null});
  assert.equal(parseNameParts('Impact Winter Tome 2 English EditionTravis Beacham [MP3]').title,'Impact Winter Tome 2 Travis Beacham');
  assert.equal(parseNameParts('The French Revolution - An Author [MP3]').title,'The French Revolution');
  t.mock.method(global,'fetch',async input=>{
    const url=new URL(input);const query=url.searchParams.get('term')||url.searchParams.get('q');
    assert.equal(query,'Impact Winter Travis Beacham');
    if(url.hostname!=='itunes.apple.com') return {ok:true,json:async()=>({})};
    return {ok:true,json:async()=>({results:[
      {collectionName:'Impact Winter Season 1 (Original Recording)',artistName:'Travis Beacham',artworkUrl100:'https://wrong/100x100bb.jpg'},
      {collectionName:'Impact Winter Season 2 (Original Recording)',artistName:'Travis Beacham',artworkUrl100:'https://right/100x100bb.jpg'},
    ]})};
  });
  const meta=await enrich(raw,'audiobook','fr');
  assert.equal(meta.poster,'https://right/600x600bb.jpg');assert.equal(meta.author,'Travis Beacham');
});
test('volume validation handles season, saison, book and decimal volume numbers',()=>{
  for(const alias of ['Season','Saison','Book','Livre','Volume']){
    assert.equal(_matchScore('Impact Winter Tome 2',`Impact Winter ${alias} 1`),0);
    assert.ok(_matchScore('Impact Winter Tome 2',`Impact Winter ${alias} 2`)>0);
  }
  assert.equal(_matchScore('Series Tome 1.5','Series Volume 1.6'),0);
});
