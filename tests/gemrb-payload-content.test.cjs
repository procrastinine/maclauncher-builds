const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Content=require('../producers/maclauncher/src/modules/gemrb/runtime/payload-content');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gemrb-content-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const app=path.join(root,'gemrb.app');for(const name of Content.OPTIONAL_TESTS){const target=path.join(app,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'optional test');}return{root,app};}
test('optional test removal validates all files before deletion and rejects directory aliases', t => {
  const f = fixture(t), directory = path.join(f.app, 'Contents/Resources/GUIScripts/test');
  fs.renameSync(directory, path.join(f.root, 'preserved')); fs.symlinkSync(path.join(f.root, 'preserved'), directory);
  assert.throws(() => Content.omitOptionalTests(f.app), /symlink/);
  assert.ok(fs.existsSync(path.join(f.app, 'Contents/Resources/GUIScripts/demo/Tests.py')));
  assert.ok(fs.existsSync(path.join(f.root, 'preserved/Start.py')));
});
