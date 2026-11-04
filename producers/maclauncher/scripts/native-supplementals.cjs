// Public producer validation for explicitly selected native packages.
const path = require('node:path');
const B = require('../src/modules/shared/runtime/bundled-native');
const { isDeepStrictEqual } = require('node:util');
const Declaration = require('../../../lib/declaration.cjs');

function validatePublicMetadata(value) {
  const projected = require('./native-binary-tools.cjs').publicProvenance(value);
  if (!isDeepStrictEqual(value, projected)) throw new Error('Sealed native metadata contains private diagnostic fields. Restage the package before distribution.');
  return value;
}

function validateDeclaration(item) {
  Declaration.validateDeclaration(item);
  return validatePublicMetadata(item);
}
function verifySupplementals({ resourceRoot, items }) {
  if (!Array.isArray(items)) throw new Error('Native producer verification requires an explicit package list.');
  for (const item of items) {
    validateDeclaration(item);
    const directory = path.join(resourceRoot, item.directoryRelative);
    B.verifyPayload(directory, item);
    validatePublicMetadata(JSON.parse(B.readRegular(path.join(directory, item.manifestRelative), B.LIMITS.manifestBytes).bytes));
  }
  return items;
}
module.exports = { validatePublicMetadata, validateDeclaration, verifySupplementals };
