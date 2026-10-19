import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {pack,verify,catalog} from '../tools/runtime-package.mjs';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-builds-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const input=path.join(root,'sealed');fs.mkdirSync(input);
 const files=Object.entries({'runtime.json':'{"schemaVersion":1}\n','library.dat':'runtime data','LICENSE':'MIT license','source.tar.gz':'corresponding source fixture'}).map(([name,bytes])=>{const file=path.join(input,name);fs.writeFileSync(file,bytes,{mode:0o644});return {path:name,size:Buffer.byteLength(bytes),mode:0o644,sha256:digest(bytes)};});
 const declaration={id:'fixture',version:'1.0.0',arch:'arm64',minimumMacOS:'13.0',launcherArchitectures:['arm64'],directoryRelative:'fixture/1.0.0/arm64',manifestRelative:'runtime.json',manifestSha256:files[0].sha256,sourceRelative:'source.tar.gz',sourceSha256:files[3].sha256,files,notices:[{name:'Fixture',license:'MIT',path:'LICENSE',sourceUrl:'https://example.com/source'}],redistribution:'bundle'};
 return {root,input,declaration,output:path.join(root,'package.tar.gz')};
}
test('sealed data/runtime packages round trip and produce a manually updated catalog',async t=>{
 const f=fixture(t),record=await pack(f),result=await verify({archive:f.output,sha256:record.asset.sha256});
 assert.equal(result.files,4);assert.equal(result.id,'fixture');assert.equal(record.updatePolicy,'manual');
 const c=catalog([record],{repository:'owner/maclauncher-builds'});assert.equal(c.updatePolicy,'manual');
 assert.equal(c.packages[0].asset.url,'https://github.com/owner/maclauncher-builds/releases/download/fixture-1.0.0-arm64/package.tar.gz');
 await assert.rejects(verify({archive:f.output,sha256:'0'.repeat(64)}),/checksum/);
 assert.throws(()=>catalog([record,record]),/duplicate/);
 for(const changed of [{id:'../outside'},{version:'bad?tag'},{asset:{...record.asset,filename:'../file'}},{minimumMacOS:'unknown'},{accessToken:'private'}])
  assert.throws(()=>catalog([{...record,...changed}],{repository:'owner/builds'}),/Invalid|private/);
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
  await assert.rejects(verify({archive:file,sha256:digest(compressed)}),/regular files|path/i);
 }
});
