const test = require('node:test');
const assert = require('node:assert/strict');
const shared = id => require('../producers/dependencies/' + id + '.json');
const base = '../producers/package-support/src/modules/';
const modulePin = file => require(base + file).PIN;

test('portable runtimes share source records while retaining each build options', () => {
  for (const [file, id, authority] of [
    ['alicesoft/system4-portable-v3', 'webp', 'alicesoft/system35-portable-v3'],
    ['shared/onsyuri/runtime/portable-build', 'webp', 'alicesoft/system35-portable-v3'],
    ['shared/onsyuri/runtime/portable-build', 'turbojpeg', 'alicesoft/system4-portable-v3']
  ]) {
    const selected = modulePin(file).dependencies.find(pin => pin.id === id);
    const canonical = modulePin(authority).dependencies.find(pin => pin.id === id);
    for (const field of ['revision', 'archiveUrl', 'archiveSha256', 'archiveBytes', 'version']) assert.equal(selected[field], canonical[field], id + ' ' + field);
  }
  assert.equal(modulePin('alicesoft/system4-portable-v3').dependencies.find(pin=>pin.id==='webp').revision,shared('webp').revision);
  assert.equal(modulePin('alicesoft/system4-portable-v3').dependencies.find(pin=>pin.id==='turbojpeg').revision,shared('turbojpeg').revision);
});

test('portable URLs derive from canonical pins and retain archive integrity and build options', () => {
  for (const name of ['portable-sdl2-fonts', 'portable-sndfile', 'portable-sdl2-mixer']) {
    const metadata = require(base + 'shared/runtime/' + name + '.json');
    const selected = modulePin('shared/runtime/' + name);
    for (const source of metadata.dependencies) {
      const pin = selected.dependencies.find(row=>row.id===source.id), record = source.archiveSha256 ? undefined : shared(source.id), canonical = record || source;
      assert.equal(pin.archiveSha256,canonical.sha256 || canonical.archiveSha256);
      assert.equal(pin.archiveBytes,canonical.bytes || canonical.archiveBytes);
      assert.deepEqual(pin.options,source.options);
      assert.equal(pin.archiveUrl.includes('{revision}'),false);
      if (source.archiveUrl) assert.equal(pin.archiveUrl,source.archiveUrl.replaceAll('{revision}',pin.revision));
      if (record) assert.equal(pin.revision,record.revision);
      else assert.equal(pin.revision,source.revision);
      assert.equal(/\b[a-f0-9]{40}\b/.test(source.archiveUrl || ''),false);
      assert.equal(/\b[a-f0-9]{40}\b/.test(source.sourceUrl || ''),false);
    }
  }
});

test('portable libffi keeps its configured release archive separate from raw Git source',()=>{
 const pin=modulePin('alicesoft/system4-portable-v3').dependencies.find(pin=>pin.id==='libffi');
 assert.equal(pin.revision,shared('libffiPortable').revision);
 assert.equal(pin.archiveUrl,shared('libffiPortable').url);
 assert.equal(pin.archiveSha256,shared('libffiPortable').sha256);
 assert.equal(pin.archiveBytes,shared('libffiPortable').bytes);
 assert.match(pin.archiveUrl,/\/releases\/download\//);
 assert.equal(require(base+'alicesoft/system4-portable.json').dependencies.find(pin=>pin.id==='libffi').archiveUrl,undefined);
});
