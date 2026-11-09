import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import Contract from '../lib/package-contract.cjs';
import B from '../lib/package-format.cjs';
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
 for(const changes of [{launcherContract:0},{launcherContract:1.5},{capabilities:[]},{capabilities:{'invalid key':1}},
  {nativeApi:'legacy-field'},
  {source:{...source,extra:true}},{source:{...source,path:'../outside'}},{source:{...source,revision:'branch'}},
  {source:{...source,repository:'https://github.com/owner/repo'}}])assert.throws(()=>releaseRecord({...value,...changes},options));
 for(const source of [{...value.source,path:'/Users/private/source'}, {...value.source,path:path.posix.join('src','.local','data')}])assert.throws(()=>releaseRecord({...value,source},options));
 assert.throws(()=>releaseRecord({...value,capabilities:{path:'/Users/private/source'}},options),/private/);
 assert.throws(()=>releaseRecord({...value,accessToken:'private'},options),/Invalid|private/);
});

test('the package contract is Builds-owned and reads no app file',()=>{
 for(const file of ['lib/package-contract.cjs','lib/package-format.cjs'])assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'),/app-source|sources\/maclauncher/);
 assert.equal(fs.existsSync(path.join(root,'producers/maclauncher')),false);
});

test('shared declarations retain the launcher CPU and optional-load schema',()=>{
 const file={path:'helper.dylib',size:32,sha256:'a'.repeat(64),mode:0o755,architectures:['arm64']};
 const declaration={id:'sample',version:'1.0',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',sourceRelative:null,sourceSha256:'b'.repeat(64),manifestRelative:'manifest.json',manifestSha256:'c'.repeat(64),directoryRelative:'sample/1.0/arm64',files:[file,{path:'manifest.json',size:1,mode:0o644,sha256:'c'.repeat(64)}]};
 Contract.validateDeclaration(declaration);
 for(const change of [
  {files:[{...file,executionArchitecture:'x86_64'},declaration.files[1]]},
  {files:[{...file,optionalLoad:{architectures:['x86_64'],minimumMacOS:'13.0'}},declaration.files[1]]},
  {files:[{...file,optionalLoad:{architectures:['arm64'],minimumMacOS:'12.0'}},declaration.files[1]]},
  {launcherArchitectures:['arm64','x64']}
 ])assert.throws(()=>Contract.validateDeclaration({...declaration,...change}));
});

test('shared manifest schema requires declared executable, dependency, asset and environment paths',()=>{
 const manifest={schemaVersion:1,managerId:'sample',version:'1.0',platform:'darwin',arch:'arm64',minimumMacOS:'13.0',upstreamRevision:'a'.repeat(40),provenance:{sourceRevision:'a'.repeat(40)},executableRelative:'bin/helper',files:[{path:'bin/helper',size:32,sha256:'b'.repeat(64),mode:0o755,architectures:['arm64']},{path:'assets/data',size:1,sha256:'c'.repeat(64),mode:0o644}],dependencies:[{file:'bin/helper',links:[]}],runtimeFiles:{data:'assets/data'},environmentRelative:{PYTHONHOME:'assets'}};
 B.validateManifest(manifest);
 for(const change of [{executableRelative:'bin/absent'},{dependencies:[{file:'bin/absent',links:[]}]},{runtimeFiles:{data:'assets/absent'}},{environmentRelative:{PYTHONHOME:'absent'}}])assert.throws(()=>B.validateManifest({...manifest,...change}));
});
