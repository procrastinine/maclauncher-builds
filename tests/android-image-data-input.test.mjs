import {aimSource} from '../lib/android-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {helperPackage} from '../tools/helper-package.mjs';
import {imageDataContentIdentity} from '../tools/build-android-image-data.mjs';
import {preparePackageLayout,materializePackageAliases} from '../tools/package-layout.mjs';
import {readImageDataInputs,materializeImageDataInputs} from '../tools/android-image-data-input.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'image-data-input-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const descriptor=fileURLToPath(new URL('../producers/android-image-data/source.json',import.meta.url));
 const profile=JSON.parse(fs.readFileSync(descriptor)),data=new Map(),records=[{path:[],kind:'directory',mode:0o755}];
 const repeated=Buffer.from('same image chunk');
 const chunks=['00000001-0000','00000001-0001'].map(name=>{data.set(name,repeated);return {data:name,size:repeated.length,sha256:hash(repeated)};});
 const whole=Buffer.concat([repeated,repeated]);
 records.push({path:[...Buffer.from('chunked-file')],kind:'file',mode:0o644,data:'00000001',size:whole.length,sha256:hash(whole),chunks});
 for(let n=2;n<=5;n++){
  const name=String(n).padStart(8,'0'),bytes=Buffer.from('original image object '+n);data.set(name,bytes);
  records.push({path:[...Buffer.from('file-'+n)],kind:'file',mode:0o644,data:name,size:bytes.length,sha256:hash(bytes)});
 }
 const transport={source_revision:aimSource().revision,archive_sha256:profile.archive.sha256,records};
 profile.content=imageDataContentIdentity(transport,{targetSymlinkMode:profile.targetSymlinkMode});
 transport.shards=profile.profiles.map((part,i)=>{
  const objects=i===0?chunks:[{data:records[i+1].data,size:records[i+1].size,sha256:records[i+1].sha256}];
  return {...part,objects,bytes:objects.reduce((n,item)=>n+item.size,0)};
 });
 const text=JSON.stringify(profile),read=fs.readFileSync.bind(fs);
 t.mock.method(fs,'readFileSync',(file,...args)=>{
  if((file instanceof URL?fileURLToPath(file):String(file))===descriptor)return args[0]==='utf8'?text:Buffer.from(text);
  return read(file,...args);
 });
 const sourceSha256=hash(text),inputs=[];
 for(const shard of transport.shards){
  const output=path.join(root,shard.id),payload=path.join(output,'payload');fs.mkdirSync(path.join(payload,'data'),{recursive:true});
  for(const object of shard.objects)fs.writeFileSync(path.join(payload,'data',object.data),data.get(object.data));
  fs.writeFileSync(path.join(payload,'image-data.json'),JSON.stringify(transport));
  fs.writeFileSync(path.join(payload,'content.json'),JSON.stringify(profile.content));
  fs.mkdirSync(path.join(payload,'notices'));fs.writeFileSync(path.join(payload,'notices/LICENSE'),'test image notice');
  helperPackage({id:shard.id,version:shard.version,arch:'arm64',output,minimumMacOS:'13.0',sourceSha256,manifestRelative:'input.json',record:{format:'android-image-data-v1',upstreamRevision:aimSource().revision,
    originalArchiveSha256:profile.archive.sha256,targetSymlinkMode:profile.targetSymlinkMode,content:profile.content,
    transportSha256:hash(JSON.stringify(transport)),dataShard:shard}});
  const declaration=JSON.parse(fs.readFileSync(path.join(output,'declaration.json')));
  preparePackageLayout({input:payload,declaration,environment:{}});
  materializePackageAliases({root:payload,declaration,inputs:{}});
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration));inputs.push(output);
 }
 return {root,inputs,transport,data};
}

test('image shard readers retain every indexed object after ordinary package aliases are materialized',t=>{
 const f=fixture(t),declaration=JSON.parse(fs.readFileSync(path.join(f.inputs[0],'declaration.json')));
 assert.equal(declaration.files.filter(file=>file.path.startsWith('data/')).length,1);
 assert.equal(f.transport.shards[0].objects.length,2);
 assert.equal(declaration.aliases.files['data/00000001-0001'],'data/00000001-0000');
 const selected=readImageDataInputs(f.inputs);assert.equal(selected.objects.size,6);
 const restored=materializeImageDataInputs({inputs:f.inputs,output:path.join(f.root,'restored')});
 for(const [name,bytes]of f.data)assert.deepEqual(fs.readFileSync(path.join(restored.root,'data',name)),bytes);
});

test('image shard readers reject corrupted materialized alias bytes',t=>{
 const f=fixture(t),input=f.inputs[0];
 fs.writeFileSync(path.join(input,'payload/data/00000001-0001'),Buffer.alloc(f.data.get('00000001-0001').length,7));
 assert.throws(()=>readImageDataInputs(f.inputs),/checksum|alias/i);
});
