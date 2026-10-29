import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import Contract from '../lib/package-contract.cjs';
import {releaseRecord} from '../lib/project-identity.mjs';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function record(){return {schemaVersion:2,id:'sample',version:'1.0',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',manifestRelative:'manifest.json',manifestSha256:'a'.repeat(64),sourceSha256:'b'.repeat(64),updatePolicy:'manual',asset:{filename:'sample-1.0-arm64.tar.gz',sha256:'c'.repeat(64),bytes:1}};}

test('producer records and consumers share generic capability and exact source validation',()=>{
 const metadata={launcherContract:2,capabilities:{format:'vm-v1',nativeApi:'api.1',draft:false,nativeFeatures:['storage.dirlist'],wadVersions:[0,0xffffffff],futureFact:'../arbitrary-scalar',nativeAbi:{eventLoop:'sdl'}}};
 const source={repository:'owner/repo',revision:'d'.repeat(40),path:'src/engine'};
 const value={...record(),...metadata,source},options={project:'sample',repository:'owner/builds'};
 assert.equal(releaseRecord(value,options),value);
 assert.deepEqual(Contract.compatibilityMetadata(value),metadata);
 assert.deepEqual(Contract.sourceMetadata(source),source);
 assert.equal(Contract.sourceMetadata(undefined),undefined);
 assert.throws(()=>Contract.packageRecord(value,{projectId:'sample',repository:'owner/builds',requireUrl:false}),/newer MacLauncher/);
 const current=Contract.packageRecord(value,{projectId:'sample',repository:'owner/builds',launcherContract:2,requireUrl:false});
 assert.deepEqual(current.source,source);assert.deepEqual(current.capabilities,metadata.capabilities);
 const tooMany=Object.fromEntries(Array.from({length:65},(_,n)=>['feature'+n,n]));
 for(const changes of [{launcherContract:0},{launcherContract:1.5},{capabilities:[]},{capabilities:{'invalid key':1}},{capabilities:tooMany},
  {capabilities:{engine:{profile:{abi:{version:1}}}}},{capabilities:{note:'x'.repeat(8192)}},{nativeApi:'legacy-field'},
  {source:{...source,extra:true}},{source:{...source,path:'../outside'}},{source:{...source,revision:'branch'}},
  {source:{...source,repository:'https://github.com/owner/repo'}}])assert.throws(()=>releaseRecord({...value,...changes},options));
 for(const source of [{...value.source,path:'/Users/private/source'}, {...value.source,path:'src/.local/data'}])assert.throws(()=>releaseRecord({...value,source},options));
 assert.throws(()=>releaseRecord({...value,capabilities:{path:'/Users/private/source'}},options),/private/);
 assert.throws(()=>releaseRecord({...value,accessToken:'private'},options),/Invalid|private/);
});

test('generated contract and bundle verifier copies are hash-pinned and refresh rejects drift',async t=>{
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'native-contract-copy-'));t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
 const producer=path.join(root,'producers/maclauncher'),targetProducer=path.join(fixture,'builds/producers/maclauncher'),sourceRoot=path.join(fixture,'source');
 fs.mkdirSync(targetProducer,{recursive:true});
 const recipe=JSON.parse(fs.readFileSync(path.join(producer,'native-tools-source.json')));
 fs.copyFileSync(path.join(producer,'native-tools-source.json'),path.join(targetProducer,'native-tools-source.json'));
 fs.copyFileSync(path.join(producer,'refresh-native-tools.mjs'),path.join(targetProducer,'refresh-native-tools.mjs'));
 for(const row of recipe.files){
  const current=path.join(row.destination?root:producer,row.destination||row.path),output=fs.readFileSync(current,'utf8');
  assert.equal(digest(output),row.sha256);
  let input=output;for(const change of [...(row.replacements||[])].reverse()){assert.equal(input.split(change.to).length,2);input=input.replace(change.to,change.from);}
  assert.equal(digest(input),row.sourceSha256);
  const source=path.join(sourceRoot,row.path),target=path.join(row.destination?path.join(fixture,'builds'):targetProducer,row.destination||row.path);
  fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,input);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,output);
 }
 const {refreshNativeTools}=await import(pathToFileURL(path.join(targetProducer,'refresh-native-tools.mjs')));
 assert.equal(refreshNativeTools(sourceRoot,{check:true}).files,recipe.files.length);
 const row=recipe.files.find(row=>row.destination==='lib/package-contract.cjs');assert.ok(row);
 const target=path.join(fixture,'builds',row.destination);fs.appendFileSync(target,'\n');
 assert.throws(()=>refreshNativeTools(sourceRoot,{check:true}),/local changes/);
 assert.throws(()=>refreshNativeTools(sourceRoot),/local changes/);
});
