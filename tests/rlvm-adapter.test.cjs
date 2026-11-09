const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'producer-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const Native=require('../lib/package-format.cjs'),MachO=require('../lib/macho-load-commands.cjs');
test('RLVM accepts the Runtime selected version before checking the requested CPU', async t=>{
 const root=temporary(t),command=path.resolve(__dirname,'../producers/vn-adaptations/rlvm/package.mjs');
 const {resolveProject,buildRecord}=await import('../lib/projects.mjs'),version=buildRecord(resolveProject('rlvm-adapter',path.resolve(__dirname,'..'),{resolvePins:false})).version;
 const result=require('node:child_process').spawnSync(process.execPath,[command,'--project','rlvm-adapter','--version',version,'--arch','x64','--output',path.join(root,'output'),'--work',path.join(root,'work')],{encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/builds universal packages on GitHub/);
 assert.equal(fs.existsSync(path.join(root,'work')),false);
});
test('RLVM packaging requires an explicit compiled source-build product', async t=>{
 const root=temporary(t),output=path.join(root,'missing');
 const {packageAdapter}=await import('../producers/vn-adaptations/rlvm/package.mjs');
 await assert.rejects(packageAdapter({output}),/explicit compiled adapter/);
 assert.equal(fs.existsSync(output),false);
});

test('Runtime RLVM builds use owned source and record the generated binary', {skip:process.platform!=='darwin'}, async t=>{
 const root=temporary(t);
 const {compile,assemble}=await import('../producers/vn-adaptations/rlvm/package.mjs'),read=fs.readFileSync;
 const options={project:'rlvm-adapter',arch:'universal',output:path.join(root,'build'),work:path.join(root,'work')};
 const result=await assemble({...options,compiled:await compile(options)});
 const binary=path.join(root,'build/payload/files/rlvm-adapter.dylib'),profile=JSON.parse(read(path.join(root,'build/payload/files/adapter.json')));
 assert.equal(profile.sha256,require('node:crypto').createHash('sha256').update(read(binary)).digest('hex'));
 const {resolveProject,buildRecord}=await import('../lib/projects.mjs');assert.equal(result.declaration.version,buildRecord(resolveProject('rlvm-adapter',path.resolve(__dirname,'..'),{resolvePins:false})).version);
 assert.deepEqual(new Set(Native.readMachOArchitectures(binary,{allowLibrary:true})),new Set(['arm64','x86_64']));
 const system=value=>/^\/(?:usr\/lib|System\/Library)\//.test(value);
 for(const image of MachO.readMachOLoadCommands(binary).slices){
  assert.equal(image.fileType,6);assert.equal(image.installName?.path,'@rpath/rlvm-adapter.dylib');
  assert.equal(image.platform,1);assert.ok(Native.versionAtLeast('13.0',image.minimumMacOS),image.minimumMacOS);
  assert.ok(image.dependencies.every(library=>system(library.path)),'The adapter links only system libraries');
  assert.ok(!image.dynamicLinker&&!image.dyldEnvironment.length);
  assert.ok(image.runPaths.every(value=>system(value)||/^@(?:loader|executable)_path(?:\/|$)/.test(value)),'The adapter has no external search path');
 }
});
