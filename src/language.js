// Preferences are per install. Existing installs without French sources keep
// their original ordering; French tracker installs default to French first.
const FRENCH_TRACKERS = new Set(['c411', 'tr4ker', 'torr9']);
function normalizeLanguage(value) {
  const text = String(value || '').toLowerCase();
  if (/^(fr|fra|fre|french|français|francais)(?:[-_].*)?$/.test(text)) return 'fr';
  if (/^(en|eng|english|anglais)(?:[-_].*)?$/.test(text)) return 'en';
  if (/^[a-z]{2}(?:[-_][a-z]{2})?$/.test(text)) return text.slice(0, 2);
  return null;
}
function preferredLanguage(cfg = {}) {
  if (['fr', 'en'].includes(cfg.languageFilter)) return cfg.languageFilter;
  if (cfg.preferredLanguage === 'any') return null;
  if (['fr', 'en'].includes(cfg.preferredLanguage)) return cfg.preferredLanguage;
  return cfg.c411ApiKey || cfg.tr4kerApiKey || cfg.torr9Passkey ? 'fr' : null;
}
function releaseLanguage(item) {
  const declared = normalizeLanguage(item.language);
  if (declared) return declared;
  if (String(item.language || '').trim()) return null;
  const name = String(item.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // A French tracker can also carry English releases. Explicit labels win.
  if (/(?:^|[^a-z])(?:multi|multilingual)(?:$|[^a-z])/i.test(name)) return null;
  const french = /(?:^|[^a-z])(?:french|francais|vff|vfq|vf|vfi)(?:$|[^a-z])/i.test(name);
  const english = /(?:^|[^a-z])(?:english|anglais|eng)(?:$|[^a-z])/i.test(name);
  const frenchTag = /\[FR\]|\(FR\)|(?:^|[._ -])FR$/.test(name);
  const englishTag = /\[EN\]|\(EN\)|(?:^|[._ -])EN$/.test(name);
  if (!french && !frenchTag && !english && !englishTag) return isFrenchTracker(item) ? 'fr' : null;
  if ((french || frenchTag) === (english || englishTag)) return null;
  return french || frenchTag ? 'fr' : 'en';
}
function matchesLanguageFilter(item, cfg = {}) {
  if (!['fr', 'en'].includes(cfg.languageFilter)) return true;
  // French trackers default to French. Other sources, including AudiobookBay,
  // need a language field or explicit release tag.
  return releaseLanguage(item) === cfg.languageFilter;
}
function isFrenchTracker(item) {
  return FRENCH_TRACKERS.has(String(item.tracker || '').trim().toLowerCase());
}
function languageScore(item, preferred) {
  if (!preferred) return 0;
  const language = releaseLanguage(item);
  if (language) return language === preferred ? 2 : -1;
  // Ambiguous releases can retain a source preference outside exclusive mode.
  return preferred === 'fr' && isFrenchTracker(item) ? 1 : 0;
}
module.exports = { matchesLanguageFilter, normalizeLanguage, preferredLanguage, releaseLanguage, isFrenchTracker, languageScore };
