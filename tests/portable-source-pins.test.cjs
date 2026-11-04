const test = require("node:test");
const assert = require("node:assert/strict");
const base = "../producers/maclauncher/src/modules/";
const sources = require(base + "alicesoft/system35-portable.json");
const system4 = require(base + "alicesoft/system4-portable.json");
const yuri = require(base + "shared/onsyuri/runtime/portable-build.json");
const sourceFields = ["revision", "repository", "archiveSha256", "archiveBytes", "version"];

test("portable runtimes share source records while retaining each build's options", () => {
  for (const [file, config, id, authority] of [
    ["alicesoft/system4-portable-v3", system4, "webp", sources],
    ["shared/onsyuri/runtime/portable-build", yuri, "webp", sources],
    ["shared/onsyuri/runtime/portable-build", yuri, "turbojpeg", system4]
  ]) {
    const local = config.dependencies.find(pin => pin.id === id);
    const canonical = authority.dependencies.find(pin => pin.id === id);
    const selected = require(base + file).PIN.dependencies.find(pin => pin.id === id);
    assert.deepEqual(Object.keys(local).sort(), ["id", "options"]);
    for (const field of sourceFields) assert.equal(selected[field], canonical[field], id + " " + field);
    assert.deepEqual(selected.options, local.options);
    assert.equal(selected.archiveUrl, canonical.archiveUrl.replaceAll("{revision}", canonical.revision));
  }
  assert.deepEqual(sources.dependencies.map(pin => pin.id), ["cjson", "webp"]);
  const mixer = require(base + "shared/runtime/portable-sdl2-mixer.json");
  assert.deepEqual(mixer.dependencies.map(pin => pin.id), ["opusfile", "sdl2_mixer"]);
  assert.match(mixer.dependencies[0].revision, /^[a-f0-9]{40}$/);
});

test("portable download URLs derive from one JSON revision and preserve archive integrity pins", () => {
  for (const name of ["portable-sdl2-fonts", "portable-sndfile", "portable-sdl2-mixer"]) {
    const metadata = require(base + "shared/runtime/" + name + ".json");
    const selected = require(base + "shared/runtime/" + name).PIN;
    for (const source of metadata.dependencies) {
      const pin = selected.dependencies.find(row => row.id === source.id);
      assert.equal(pin.archiveUrl, source.archiveUrl.replaceAll("{revision}", source.revision));
      assert.equal(pin.archiveSha256, source.archiveSha256);
      assert.equal(pin.archiveBytes, source.archiveBytes);
      assert.equal(pin.revision, source.revision);
      assert.deepEqual(pin.options, source.options);
      assert.equal(/\b[a-f0-9]{40}\b/.test(source.archiveUrl), false);
      assert.equal(Object.hasOwn(source, "sourceUrl") && /\b[a-f0-9]{40}\b/.test(source.sourceUrl), false);
    }
  }
});
