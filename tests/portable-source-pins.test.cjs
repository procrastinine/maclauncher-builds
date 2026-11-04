const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {gitlink} = require('../lib/pins.mjs');
const shared = require('../producers/dependencies.json');
const base = '../producers/maclauncher/src/modules/';
const modulePin = file => require(base + file).PIN;
const upstream = name => execFileSync('git', ['-C', path.resolve(__dirname, '../sources/anyps5'), 'rev-parse', gitlink('sources/anyps5') + ':3rdparty/' + name], {encoding:'utf8'}).trim();

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
  assert.equal(modulePin('alicesoft/system4-portable-v3').dependencies.find(pin=>pin.id==='webp').revision,shared.webp.revision);
  assert.equal(modulePin('alicesoft/system4-portable-v3').dependencies.find(pin=>pin.id==='turbojpeg').revision,upstream('libjpeg-turbo'));
});

test('portable URLs derive from canonical pins and retain archive integrity and build options', () => {
  for (const name of ['portable-sdl2-fonts', 'portable-sndfile', 'portable-sdl2-mixer']) {
    const metadata = require(base + 'shared/runtime/' + name + '.json');
    const selected = modulePin('shared/runtime/' + name);
    for (const source of metadata.dependencies) {
      const pin = selected.dependencies.find(row=>row.id===source.id), canonical = shared[source.id] || source;
      assert.equal(pin.archiveSha256,canonical.sha256 || canonical.archiveSha256);
      assert.equal(pin.archiveBytes,canonical.bytes || canonical.archiveBytes);
      assert.deepEqual(pin.options,source.options);
      assert.equal(pin.archiveUrl.includes('{revision}'),false);
      if (source.archiveUrl) assert.equal(pin.archiveUrl,source.archiveUrl.replaceAll('{revision}',pin.revision));
      if (shared[source.id]) assert.equal(pin.revision,shared[source.id].revision);
      else if (source.id==='sdl2') assert.equal(pin.revision,upstream('SDL2'));
      else if (['ogg','opus','vorbis'].includes(source.id)) assert.equal(pin.revision,upstream(source.id));
      else assert.equal(pin.revision,source.revision);
      assert.equal(/\b[a-f0-9]{40}\b/.test(source.archiveUrl || ''),false);
      assert.equal(/\b[a-f0-9]{40}\b/.test(source.sourceUrl || ''),false);
    }
  }
});
