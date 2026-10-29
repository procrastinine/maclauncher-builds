const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

module.exports = function requirements({ sourceTree, appleSiliconMacOS = false } = {}) {
  const unavailable = [];
  if (sourceTree !== undefined) {
    if (typeof sourceTree !== 'string' || !sourceTree.startsWith('producers/') || sourceTree.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(sourceTree))
      throw Error('A test source requirement must name a producer-relative tree.');
    const directory = path.join(root, sourceTree);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length === 0)
      unavailable.push('Source tree ' + sourceTree + ' is not initialized.');
  }
  if (appleSiliconMacOS && (process.platform !== 'darwin' || process.arch !== 'arm64'))
    unavailable.push('Requires Apple Silicon macOS.');
  return { skip: unavailable.length ? unavailable.join(' ') : false };
};
