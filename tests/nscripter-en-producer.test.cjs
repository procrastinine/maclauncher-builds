const test=require('node:test'),assert=require('node:assert/strict');
const Build=require('../producers/maclauncher/src/modules/nscripter/runtime/onscripter-en-build-v3');
const {gitlink}=require('../lib/pins.mjs');
test("ONScripter-EN source and portable SDL archive inputs resolve offline", () => {
  const revision=gitlink('producers/maclauncher/src/external/onscripter-en');
  assert.equal(Build.PACKAGES.source.url, `https://github.com/Galladite27/ONScripter-EN/archive/${revision}.tar.gz`);
  assert.equal(Build.PACKAGES.source.folder, `ONScripter-EN-${revision}`);
  for (const name of ['source','sdl12','sdl2']) {
    const pin=Build.PACKAGES[name];
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.match(pin.url, /^https:\/\//);
    assert.ok(pin.folder && !pin.folder.includes('..') && !pin.folder.includes('/'));
  }
  assert.deepEqual(Build.SOURCE_SCOPE, {kind:'primary-tree',omittedSubmodules:['test/googletest']});
});
