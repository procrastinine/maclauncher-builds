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

test('published catalogs accept only additive source and capability backfills without changing payload identity',async t=>{
 const f=fixture(t),record=await pack(f),options={project:f.project,repository:'owner/builds'},previous=catalog([record],options),archiveHash=digest(fs.readFileSync(f.output));
 const source={repository:'owner/runtime',revision:'d'.repeat(40)};
 const filled={...record,source,capabilities:{decodedFrameAPI:1,nativeAbi:{eventLoop:'sdl'},formats:['vm']},launcherContract:1};
 const backfilled=catalog([filled],{...options,previous});
 assert.deepEqual(backfilled.packages[0].source,source);assert.deepEqual(backfilled.packages[0].capabilities,filled.capabilities);
 assert.equal(backfilled.packages[0].asset.sha256,record.asset.sha256);assert.equal(digest(fs.readFileSync(f.output)),archiveHash);
 const added={...filled,capabilities:{...filled.capabilities,decodedColorAPI:1}};
 const extended=catalog([added],{...options,previous:backfilled});assert.equal(extended.packages[0].capabilities.decodedColorAPI,1);
 assert.deepEqual(catalog([added],{...options,previous:extended}),extended,'Identical metadata updates are idempotent');
 const without=(value,key)=>{const result={...value};delete result[key];return result;};
 for(const changed of [without(filled,'source'),without(filled,'capabilities'),without(filled,'launcherContract'),
  {...filled,source:{...source,revision:'e'.repeat(40)}},{...filled,capabilities:{decodedFrameAPI:1}},
  {...filled,capabilities:{...filled.capabilities,decodedFrameAPI:2}},
  {...filled,capabilities:{...filled.capabilities,nativeAbi:{eventLoop:'sdl',callback:'extra'}}},
  {...filled,capabilities:{...filled.capabilities,formats:['vm','native']}},{...filled,launcherContract:2},
  {...filled,minimumMacOS:'14.0'},{...filled,launcherArchitectures:['arm64','x64']},
  {...filled,manifestRelative:'other.json'},{...filled,manifestSha256:'f'.repeat(64)},
  {...filled,sourceSha256:'e'.repeat(64)},{...filled,asset:{...filled.asset,sha256:'0'.repeat(64)}},
  {...filled,asset:{...filled.asset,bytes:filled.asset.bytes+1}}])assert.throws(()=>catalog([changed],{...options,previous:backfilled}),/immutable/);
 assert.throws(()=>catalog([{...record,launcherContract:2}],{...options,previous}),/immutable/,'An omitted contract only backfills the existing contract1 semantics');
 assert.deepEqual(previous.packages[0],catalog([record],options).packages[0],'Merging does not mutate the previous catalog');
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

// Empty nested code-signature members are part of supplied macOS app bundles.
test('zero-byte app signature members retain their exact bytes and inventory',async t=>{
 const f=fixture(t),name='App.app/Contents/Resources/Assets.bundle/Contents/_CodeSignature/CodeSignature';
 fs.mkdirSync(path.dirname(path.join(f.input,name)),{recursive:true});fs.writeFileSync(path.join(f.input,name),'',{mode:0o644});
 f.declaration.files.push({path:name,size:0,mode:0o644,sha256:digest('')});
 const record=await pack(f),result=await verify({...selected(f),archive:f.output,sha256:record.asset.sha256});
 assert.equal(result.files,5);assert.throws(()=>publicDeclaration({...f.declaration,files:f.declaration.files.map(file=>file.path===name?{...file,size:-1}:file)}),/Invalid sealed/);
 fs.writeFileSync(path.join(f.input,name),'changed');
 await assert.rejects(pack({...f,output:path.join(f.root,'next',path.basename(f.output))}),/exceeds|checksum/);
});

test('downloadable metadata follows payload source pins and bundled records remain exact',async()=>{
 const {recordMetadata}=await import('../lib/record-metadata.mjs');const {resolveProject}=await import('../lib/projects.mjs');
 const project=resolveProject('siglus'),revision=project.upstreams[0].revision;
 assert.deepEqual(recordMetadata({project:'siglus',manifest:{upstreamRevision:revision}}),{capabilities:{nativeApi:'game_run_entry-v1'},source:{repository:'xmoezzz/siglus_rs',revision}});
 assert.throws(()=>recordMetadata({project:'siglus',manifest:{upstreamRevision:'f'.repeat(40)}}),/source differs/);
 assert.deepEqual(recordMetadata({project:'siglus',manifest:{upstreamRevision:revision},metadata:{capabilities:{nativeApi:'../unsafe'}}}).capabilities,{nativeApi:'../unsafe'},'Modules validate capability semantics; scalar strings are generic metadata');
 const tooMany=Object.fromEntries(Array.from({length:65},(_,n)=>['feature'+n,n]));
 const tooDeep={engine:{profile:{abi:{version:1}}}};
 for(const capabilities of [tooMany,tooDeep])assert.throws(()=>recordMetadata({project:'siglus',manifest:{upstreamRevision:revision},metadata:{capabilities}}),/capabilities/i);
 assert.throws(()=>recordMetadata({project:'siglus',manifest:{upstreamRevision:revision},metadata:{source:{repository:'owner/repo',revision:'a'.repeat(40)}}}),/source differs/);
 assert.deepEqual(recordMetadata({project:'reshade',manifest:{upstreamRevision:revision},metadata:{capabilities:{nativeApi:'unused'}}}),{});
 const mesa=resolveProject('vulkan-kosmickrisp-gles32'),mesaRevision=mesa.upstreams[0].revision;
 assert.deepEqual(recordMetadata({project:mesa.id,manifest:{upstreamRevision:mesaRevision}}),{},'A verified non-GitHub source stays packable without a fabricated GitHub identity');
 assert.throws(()=>recordMetadata({project:mesa.id,manifest:{upstreamRevision:'f'.repeat(40)}}),/source differs/);
});
