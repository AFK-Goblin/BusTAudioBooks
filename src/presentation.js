// Preserve full paths in `filename`: the companion app uses them for queue
// identity. Only the human-readable title drops directory prefixes.
function chapterTitle(filename) {
  return String(filename || '').split(/[\\/]/).filter(Boolean).pop() || '';
}
module.exports = { chapterTitle };
