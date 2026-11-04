const requirements = require('./support/requirements.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'producer-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const Build=require('../producers/maclauncher/src/modules/nscripter/runtime/onscripter-en-build-v3');
test("ONScripter-EN source pins have archive digests", requirements({ sourceTree: 'producers/maclauncher/src/external/onscripter-en/extlib/src/SDL_image-1.2.12' }), () => {
  for (const pin of Object.values(Build.PACKAGES)) assert.match(pin.sha256, /^[a-f0-9]{64}$/);
});
