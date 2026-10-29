const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native');
const Producer=require('./helpers/gamemaker-opengl.cjs');
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'opengl-native-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const {pathToFileURL}=require('node:url');
test('the OpenGL producer compiles its declared source into a universal library',{skip:process.platform!=='darwin'},async t=>{
 const root=temporary(t),output=path.join(root,'output'),version='software-gl-v3-universal';
 const producer=await import(pathToFileURL(path.resolve(__dirname,'../producers/included-helpers/gamemaker-opengl-helper/build.mjs')).href);
 const built=producer.build({version,output});
 assert.equal(built.sourceSha256,Native.hashFile(Producer.sourcePath(version)));
 assert.deepEqual(new Set(Native.readMachOArchitectures(built.dylibPath,{allowLibrary:true})),new Set(['arm64','x86_64']));
 assert.equal(Native.hashFile(built.dylibPath),built.binarySha256);
});
