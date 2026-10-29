const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'producer-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const directory=temporary;
test("Minori source overlay validates every pinned input before changing an owned export", t => {
  const Build = require("../producers/maclauncher/src/modules/minori/runtime/build");
  const root = directory(t), source = path.resolve(__dirname,"../producers/maclauncher/src/external/ReMinori");
  if (!fs.existsSync(path.join(source, "crates/engine/src/font.rs"))) return t.skip("Optional source submodule is not initialized.");
  for (const file of Object.keys(Build.ORIGINALS)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.copyFileSync(path.join(source, file), path.join(root, file)); }
  const original = fs.readFileSync(path.join(root, "crates/engine/src/font.rs"));
  fs.appendFileSync(path.join(root, "crates/game/src/input_adapter.rs"), "\n// changed upstream\n");
  assert.throws(() => Build.adaptSource(root), /hash differs/);
  assert.deepEqual(fs.readFileSync(path.join(root, "crates/engine/src/font.rs")), original);
  fs.copyFileSync(path.join(source, "crates/game/src/input_adapter.rs"), path.join(root, "crates/game/src/input_adapter.rs"));
  const adapted = Build.adaptSource(root); assert.equal(adapted.upstreamRevision, Build.REVISION);
  assert.ok(fs.readFileSync(path.join(root, "crates/engine/src/engine.rs"), "utf8").includes("MACLAUNCHER_MINORI_SAVE_DIR"));
  assert.ok(fs.readFileSync(path.join(root, "crates/engine/src/vfs.rs"), "utf8").includes("MACLAUNCHER_MINORI_CACHE_DIR"));
  assert.throws(() => Build.adaptSource(root), /hash differs/);
});

test("movie profile enables a finite native decoder set without networking or unreviewed system codec autodetection", () => {
  const Movies = require("../producers/maclauncher/src/modules/minori/runtime/movie-build");
  assert.ok(Movies.DECODERS.includes("wmv3")); assert.ok(Movies.DEMUXERS.includes("asf"));
  assert.ok(Movies.OPTIONS.includes("--disable-network")); assert.ok(Movies.OPTIONS.includes("--disable-gpl"));
  assert.ok(Movies.OPTIONS.includes("--disable-nonfree")); assert.ok(Movies.OPTIONS.includes("--disable-autodetect"));
  assert.equal(Movies.SOURCE.version, "7.1.2"); assert.match(Movies.SOURCE.sha256, /^[a-f0-9]{64}$/);
});
