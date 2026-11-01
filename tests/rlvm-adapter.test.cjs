const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'producer-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native'),MachO=require('../producers/maclauncher/src/modules/shared/runtime/macho-load-commands');
test('RLVM packaging requires an explicit compiled source-build product', async t=>{
 const root=temporary(t),output=path.join(root,'missing');
 const {packageAdapter}=await import('../producers/vn-adaptations/rlvm/package.mjs');
 await assert.rejects(packageAdapter({output}),/explicit compiled adapter/);
 assert.equal(fs.existsSync(output),false);
});

test('Runtime RLVM builds use owned source and record the generated binary', {skip:process.platform!=='darwin'}, async t=>{
 const root=temporary(t);
 const {build}=await import('../producers/vn-adaptations/rlvm/package.mjs'),read=fs.readFileSync;
 const result=await build({project:'rlvm-adapter',arch:'universal',output:path.join(root,'build'),work:path.join(root,'work')});
 const binary=path.join(root,'build/payload/files/rlvm-adapter.dylib'),profile=JSON.parse(read(path.join(root,'build/payload/files/adapter.json')));
 assert.equal(profile.sha256,require('node:crypto').createHash('sha256').update(read(binary)).digest('hex'));
 const {resolveProject,buildRecord}=await import('../lib/projects.mjs');assert.equal(result.declaration.version,buildRecord(resolveProject('rlvm-adapter',path.resolve(__dirname,'..'),{resolvePins:false})).version);
 assert.deepEqual(new Set(Native.readMachOArchitectures(binary,{allowLibrary:true})),new Set(['arm64','x86_64']));
 MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(binary),{fileType:6,installName:'@rpath/rlvm-adapter.dylib',maximumMacOS:'13.0'});
});
