import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {pack,verify,catalog,publicDeclaration} from '../tools/runtime-package.mjs';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-builds-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const input=path.join(root,'sealed');fs.mkdirSync(input);
 const files=Object.entries({'runtime.json':'{"schemaVersion":1}\n','library.dat':'runtime data','LICENSE':'MIT license','source.tar.gz':'corresponding source fixture'}).map(([name,bytes])=>{const file=path.join(input,name);fs.writeFileSync(file,bytes,{mode:0o644});return {path:name,size:Buffer.byteLength(bytes),mode:0o644,sha256:digest(bytes)};});
 const declaration={id:'fixture',version:'1.0.0',arch:'arm64',minimumMacOS:'13.0',launcherArchitectures:['arm64'],directoryRelative:'fixture/1.0.0/arm64',manifestRelative:'runtime.json',manifestSha256:files[0].sha256,sourceRelative:'source.tar.gz',sourceSha256:files[3].sha256,files,notices:[{name:'Fixture',license:'MIT',path:'LICENSE',sourceUrl:'https://example.com/source'}],redistribution:'bundle'};
 return {root,input,declaration,project:'fixture',output:path.join(root,'fixture-1.0.0-arm64.tar.gz')};
}
const selected=f=>({project:f.project,version:f.declaration.version,arch:f.declaration.arch});
test('sealed data/runtime packages round trip and produce a manually updated catalog',async t=>{
 const f=fixture(t),record=await pack(f),result=await verify({...selected(f),archive:f.output,sha256:record.asset.sha256});
 assert.equal(result.files,4);assert.equal(result.id,'fixture');assert.equal(record.updatePolicy,'manual');
 const c=catalog([record],{project:f.project,repository:'owner/maclauncher-builds'});assert.equal(c.updatePolicy,'manual');
 assert.equal(c.projectId,'fixture');assert.equal(c.packages[0].tag,'fixture/v1.0.0/arm64');
 assert.equal(c.packages[0].asset.url,'https://github.com/owner/maclauncher-builds/releases/download/fixture%2Fv1.0.0%2Farm64/fixture-1.0.0-arm64.tar.gz');
 await assert.rejects(verify({...selected(f),archive:f.output,sha256:'0'.repeat(64)}),/checksum/);
 assert.throws(()=>catalog([record,record],{project:f.project,repository:'owner/builds'}),/duplicate/i);
 for(const changed of [{id:'../outside'},{version:'bad?tag'},{asset:{...record.asset,filename:'../file'}},{minimumMacOS:'unknown'},{accessToken:'private'}])
  assert.throws(()=>catalog([{...record,...changed}],{project:f.project,repository:'owner/builds'}),/Invalid|private/);
});
test('package creation rejects modified bytes, extra files and aliases',async t=>{
 for(const change of ['bytes','extra','alias']){const f=fixture(t);if(change==='bytes')fs.writeFileSync(path.join(f.input,'library.dat'),'changed');else if(change==='extra')fs.writeFileSync(path.join(f.input,'unexpected'),'extra');else{fs.unlinkSync(path.join(f.input,'library.dat'));fs.symlinkSync('LICENSE',path.join(f.input,'library.dat'));}await assert.rejects(pack(f),/checksum|inventory|symlinks/);}
});
test('local-only packages and unsafe metadata cannot enter the release catalog',async t=>{
 const f=fixture(t);f.declaration.redistribution='local-only';await assert.rejects(pack(f),/restricted/);
 f.declaration.redistribution='bundle';f.declaration.files[1].path='../outside';await assert.rejects(pack(f),/Invalid|relative|path/i);
});
test('download verification rejects link and traversal headers even with a matching archive checksum',async t=>{
 const f=fixture(t);await pack(f);const original=zlib.gunzipSync(fs.readFileSync(f.output));
 const metadataSize=parseInt(original.subarray(124,136).toString('ascii').replace(/\0.*$/,''),8);
 const offset=512+Math.ceil(metadataSize/512)*512;
 for(const kind of ['link','traversal']){
  const bytes=Buffer.from(original),header=bytes.subarray(offset,offset+512);
  if(kind==='link'){header[156]=50;header.write('LICENSE',157);}
  else{header.fill(0,0,100);header.write('../outside',0);}
  header.fill(32,148,156);header.write(header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148,8);
  const compressed=zlib.gzipSync(bytes),file=path.join(f.root,kind+'.tar.gz');fs.writeFileSync(file,compressed);
  await assert.rejects(verify({...selected(f),archive:file,sha256:digest(compressed)}),/regular files|path/i);
 }
});
test('packing, catalogs and downloaded archives reject swapped project identities',async t=>{
 const f=fixture(t);await assert.rejects(pack({...f,project:'another-project'}),/expected project/);assert.equal(fs.existsSync(f.output),false);
 await assert.rejects(pack({...f,output:path.join(f.root,'wrong-project.tar.gz')}),/filename/);
 const record=await pack(f),options={project:f.project,repository:'owner/builds'},c=catalog([record],options);
 await assert.rejects(verify({...selected(f),project:'another-project',archive:f.output,sha256:record.asset.sha256}),/different project/);
 await assert.rejects(verify({...selected(f),version:'2.0',archive:f.output,sha256:record.asset.sha256}),/different project/);
 await assert.rejects(verify({...selected(f),arch:'x64',archive:f.output,sha256:record.asset.sha256}),/different project/);
 assert.throws(()=>catalog([record],{...options,project:'another-project'}),/expected project/);
 assert.throws(()=>catalog([{...c.packages[0],tag:'another-project/v1.0.0/arm64'}],options),/tag/);
 assert.throws(()=>catalog([{...c.packages[0],asset:{...c.packages[0].asset,url:c.packages[0].asset.url.replace('owner/builds','owner/other')}}],options),/URL/);
 const foreign={...record,id:'another-project',asset:{...record.asset,filename:'another-project-1.0.0-arm64.tar.gz'}};
 assert.throws(()=>catalog([record,foreign],options),/expected project/);
});
test('catalog updates retain prior versions and cannot replace an existing release',async t=>{
 const f=fixture(t),record=await pack(f),options={project:f.project,repository:'owner/builds'},previous=catalog([record],options);
 const next={...record,version:'1.0.1',asset:{...record.asset,filename:'fixture-1.0.1-arm64.tar.gz'}};
 const updated=catalog([next],{...options,previous});assert.deepEqual(updated.packages.map(record=>record.version),['1.0.1','1.0.0']);
 assert.deepEqual(catalog([record],{...options,previous}),previous);
 assert.throws(()=>catalog([{...record,asset:{...record.asset,sha256:'0'.repeat(64)}}],{...options,previous}),/immutable/);
 assert.throws(()=>catalog([record],{...options,previous:{...previous,projectId:'another-project'}}),/different project/);
});

test('optional native providers retain platform requirements and exact sealed bytes',async t=>{
 const f=fixture(t);
 for(const [name,optional] of [['baseline.dylib',false],['provider.dylib',true]]){
  const bytes=Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x0100000c,4);bytes.writeUInt32LE(6,12);
  fs.writeFileSync(path.join(f.input,name),bytes,{mode:0o755});
  f.declaration.files.push({path:name,size:bytes.length,mode:0o755,sha256:digest(bytes),architectures:['arm64'],
   ...(optional?{optionalLoad:{architectures:['arm64'],minimumMacOS:'15.0'}}:{})});
 }
 const record=await pack(f),result=await verify({...selected(f),archive:f.output,sha256:record.asset.sha256});
 assert.equal(result.files,6);assert.equal(record.minimumMacOS,'13.0');
 const raw=zlib.gunzipSync(fs.readFileSync(f.output)),size=parseInt(raw.subarray(124,136).toString('ascii').replace(/\0.*$/,''),8);
 const sealed=JSON.parse(raw.subarray(512,512+size));assert.deepEqual(sealed.files.at(-1).optionalLoad,{architectures:['arm64'],minimumMacOS:'15.0'});
 for(const optionalLoad of [null,{architectures:['x86_64'],minimumMacOS:'15.0'},{architectures:['arm64'],minimumMacOS:'12.0'}])
  assert.throws(()=>publicDeclaration({...f.declaration,files:f.declaration.files.map(file=>file.path==='provider.dylib'?{...file,optionalLoad}:file)}),/Optional native loading/);
 assert.throws(()=>publicDeclaration({...f.declaration,files:f.declaration.files.map(file=>file.architectures?
  {...file,optionalLoad:{architectures:['arm64'],minimumMacOS:'15.0'}}:file)}),/incomplete/);
});
