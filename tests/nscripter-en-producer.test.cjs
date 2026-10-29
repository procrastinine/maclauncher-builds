const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'producer-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const Build=require('../producers/maclauncher/src/modules/nscripter/runtime/onscripter-en-build-v3');
test("ONScripter-EN source pins and every included codec notice exist without network", t => {
  for (const pin of Object.values(Build.PACKAGES)) assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  const source = path.resolve(__dirname, "../producers/maclauncher/src/external/onscripter-en");
  if (!fs.existsSync(path.join(source, "extlib", "src", "SDL_image-1.2.12"))) return t.skip("ONScripter-EN codec source trees are not initialized.");
  for (const [, , relative] of Build.CODECS) assert.equal(fs.existsSync(path.join(source, "extlib", "src", relative)), true, relative);
});
