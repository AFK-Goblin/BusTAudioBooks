const torbox = require('./torbox');
const alldebrid = require('./alldebrid');
function providerFor(cfg) {
  const name = cfg.provider || 'torbox';
  if (name === 'torbox') return torbox;
  if (name === 'alldebrid') return alldebrid;
  throw new Error('Unsupported debrid provider');
}
module.exports = { providerFor };
