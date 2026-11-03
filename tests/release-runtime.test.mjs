import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareRelease,verifyRelease,applyRelease as actualApplyRelease,publicationAssets,verifyPublicAssets,stageRelease as actualStageRelease,publishRelease as actualPublishRelease,managerDeclaration,verifyRemoteRelease as actualVerifyRemoteRelease,main} from '../tools/release-runtime.mjs';
import {verifiedBuildSource} from '../tools/verified-build-run.mjs';
const stageRelease=actualStageRelease,publishRelease=actualPublishRelease,verifyRemoteRelease=actualVerifyRemoteRelease,applyRelease=actualApplyRelease;
const rawCatalog=directory=>JSON.parse(fs.readFileSync(path.join(directory,'catalogs/engine.json')));
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t,{external=false,version='1.0'}={}){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'runtime-release-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[{id:'engine',name:'Engine',delivery:'downloadable',packageProfiles:[{version,label:'Engine '+version}],producer:{kind:'prebuilt',version,architectures:['arm64']},upstreams:[]}]}));
 const input=path.join(directory,'input');fs.mkdirSync(input);
 const data={'runtime.json':JSON.stringify({version}),'LICENSE':'MIT','source.tar.gz':'source bytes'};
 if(external)delete data['source.tar.gz'];
 const files=Object.entries(data).map(([name,bytes])=>{fs.writeFileSync(path.join(input,name),bytes,{mode:0o644});return {path:name,size:Buffer.byteLength(bytes),mode:0o644,sha256:digest(bytes)};});
 const declaration={id:'engine',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',directoryRelative:'engine/'+version+'/arm64',manifestRelative:'runtime.json',manifestSha256:files[0].sha256,sourceSha256:digest('source bytes'),files,notices:[{name:'Engine',license:'MIT',path:'LICENSE'}],redistribution:'bundle'};
 let source;if(external){source=path.join(directory,'source.tar.gz');fs.writeFileSync(source,'source bytes');declaration.sourceArtifact={directoryRelative:'engine/'+version+'-source.tar.gz',sha256:digest('source bytes'),bytes:12};}else declaration.sourceRelative='source.tar.gz';
 return {project:'engine',input,declaration,source,output:path.join(directory,'release'),directory};
}
test('one selected release prepares offline and applies an independently discoverable catalog',async t=>{
 const f=fixture(t),r=await prepareRelease(f);assert.equal(r.tag,'engine/v1.0/arm64');assert.equal(r.assets.length,2);
 const checked=await verifyRelease({bundle:f.output,directory:f.directory,project:'engine',version:'1.0',arch:'arm64'});assert.equal(checked.record.version,'1.0');
 await assert.rejects(verifyRelease({bundle:f.output,directory:f.directory,project:'other'}),/differs/);
 await applyRelease({bundle:f.output,directory:f.directory,runGh:publicReleaseGh(checked.record)});assert.equal(rawCatalog(f.directory).packages[0].version,'1.0');
 await assert.rejects(prepareRelease(f),/new output/);
 fs.writeFileSync(path.join(f.output,'unexpected.txt'),'extra');await assert.rejects(verifyRelease({bundle:f.output,directory:f.directory}),/undeclared/);
});
test('build packaging emits no separate source attachment',async t=>{
 const f=fixture(t,{external:true});await prepareRelease(f);const checked=await verifyRelease({bundle:f.output,directory:f.directory});
 assert.equal(checked.record.sourceAsset,undefined);assert.deepEqual(publicationAssets(checked.release),['engine-1.0-arm64.tar.gz']);
 fs.writeFileSync(path.join(f.output,'1.0-source.tar.gz'),'changed');await assert.rejects(verifyRelease({bundle:f.output,directory:f.directory}),/undeclared files/);
});
test('packaging never reuses an existing output directory',async t=>{
 const f=fixture(t);await prepareRelease(f);const bytes=fs.readFileSync(path.join(f.output,'engine-1.0-arm64.tar.gz'));
 await assert.rejects(prepareRelease(f),/new output/);assert.deepEqual(fs.readFileSync(path.join(f.output,'engine-1.0-arm64.tar.gz')),bytes);
});

test('public attachments contain only the binary without source or metadata attachments',async t=>{
 const f=fixture(t,{external:true}),release=await prepareRelease(f);
 assert.deepEqual(publicationAssets(release),['engine-1.0-arm64.tar.gz']);
 await applyRelease({bundle:f.output,directory:f.directory,runGh:publicReleaseGh(JSON.parse(fs.readFileSync(path.join(f.output,'engine-1.0-arm64.tar.gz.json'))))});
 const assets=path.join(f.directory,'public-assets');fs.mkdirSync(assets);for(const name of publicationAssets(release))fs.copyFileSync(path.join(f.output,name),path.join(assets,name));
 await verifyPublicAssets({project:'engine',version:'1.0',arch:'arm64',assets,output:path.join(f.directory,'restored'),directory:f.directory});
 fs.writeFileSync(path.join(assets,'release.json'),'{}');await assert.rejects(verifyPublicAssets({project:'engine',version:'1.0',arch:'arm64',assets,output:path.join(f.directory,'extra'),directory:f.directory}),/only the selected runtime/);
});

test('source attachment options are rejected and legacy source roles are excluded',async t=>{
 await assert.rejects(main(['prepare','--project','engine','--source-delivery','archive','--output','unused']),/explicit options/);
 assert.deepEqual(publicationAssets({sourceDelivery:'archive',assets:[{role:'runtime',filename:'engine.tar.gz'},{role:'source',filename:'source.tar.gz'},{role:'catalog',filename:'engine.json'}]}),['engine.tar.gz']);
});

test('tag-supplied source retains its checksum without installing a source archive',async t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.input,'source.tar.gz'));f.declaration.files=f.declaration.files.filter(file=>file.path!=='source.tar.gz');f.declaration.sourceRelative=null;
 await prepareRelease(f);const checked=await verifyRelease({bundle:f.output,directory:f.directory});assert.equal(checked.record.sourceSha256,digest('source bytes'));assert.equal(checked.record.source,undefined);assert.equal(checked.record.sourceAsset,undefined);
 const {sourceRelative,...missing}=f.declaration;await assert.rejects(prepareRelease({...f,declaration:missing,output:path.join(f.directory,'missing')}),/incomplete/);
});

test('release source verification retains the current publication controller and records the historical tag',t=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'runtime-tag-source-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const upstream=path.join(directory,'upstream'),checkout=path.join(directory,'checkout');fs.mkdirSync(upstream);
 const env={...process.env,GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
 const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(upstream,['init','--initial-branch=main']);fs.writeFileSync(path.join(upstream,'projects.json'),'tagged catalog source');git(upstream,['add','projects.json']);git(upstream,['commit','-m','Tagged source']);
 const tagged=git(upstream,['rev-parse','HEAD']),tag='engine/v1.0/arm64';git(upstream,['tag',tag]);
 fs.writeFileSync(path.join(upstream,'projects.json'),'different dispatch branch source');git(upstream,['add','projects.json']);git(upstream,['commit','-m','Later branch source']);
 execFileSync('git',['clone','--quiet','--no-hardlinks',upstream,checkout],{env,stdio:'pipe'});assert.notEqual(git(checkout,['rev-parse','HEAD']),tagged);
 const workflow=fs.readFileSync(new URL('../.github/workflows/runtime-build.yml',import.meta.url),'utf8');
 assert.match(workflow,/ref: main/,'Publication uses the current main controller.');
 const controller=git(checkout,['rev-parse','HEAD']);
 const selected=verifiedBuildSource({workflowName:'Build and release',status:'completed',headBranch:'main',headSha:tagged,jobs:[{name:'build (engine 1.0 arm64)',status:'completed',conclusion:'success'}]},{project:'engine',version:'1.0',arch:'arm64'});
 assert.equal(selected,git(checkout,['rev-parse',tag+'^{commit}']));
 assert.equal(git(checkout,['rev-parse','HEAD']),controller);assert.equal(fs.readFileSync(path.join(checkout,'projects.json'),'utf8'),'different dispatch branch source');
 const publisher=fs.readFileSync(new URL('../tools/publish-package.mjs',import.meta.url),'utf8');assert.match(publisher,/stageBundle\(\{\.\.\.options,target:sourceRevision,resume:true\}\)/);
});

const sourceTarget='a'.repeat(40),annotation='b'.repeat(40);
const refResult=(sha=sourceTarget,type='commit')=>JSON.stringify({object:{sha,type}});
const notFound=()=>Object.assign(Error('ref missing'),{stderr:'gh: Not Found (HTTP 404)'});
const remoteRelease=(record,draft=false)=>({id:17,tag_name:record.id+'/v'+record.version+'/'+record.arch,draft,assets:[{id:1,name:record.asset.filename,size:record.asset.bytes,state:'uploaded',digest:'sha256:'+record.asset.sha256}]});
function publicReleaseGh(record){return async args=>{
 assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);
 if(args[1].includes('/git/ref/'))return refResult();
 assert.deepEqual(args,['api','repos/owner/builds/releases/tags/engine%2Fv'+encodeURIComponent(record.version)+'%2Farm64']);
 return JSON.stringify(remoteRelease(record));
};}
test('staging supplies the source commit and carries the returned release ID without creating refs',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory}),calls=[];
 const runGh=async args=>{calls.push(args);const endpoint=args.find(value=>value.startsWith('repos/')||value.startsWith('https://uploads.'));
  assert.ok(!args.includes('repos/owner/builds/git/refs'));
  if(endpoint.includes('/git/ref/'))return refResult();
  if(endpoint.includes('/releases/tags/'))throw notFound();
  if(endpoint==='repos/owner/builds/releases')return JSON.stringify({...remoteRelease(record,true),assets:[]});
  if(endpoint.startsWith('https://uploads.')){assert.ok(endpoint.includes('/releases/17/assets?'));return JSON.stringify(remoteRelease(record).assets[0]);}
  if(endpoint==='repos/owner/builds/releases/17'){assert.ok(args.includes('PATCH'));return JSON.stringify(remoteRelease(record));}
  assert.fail(args.join(' '));
 };
 const staged=await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});
 assert.equal(staged.id,17);assert.equal(staged.draft,true);
 const published=await publishRelease({bundle:f.output,directory:f.directory,runGh,publication:staged});assert.equal(published.draft,false);
 assert.equal(calls.filter(args=>args.includes('POST')).length,2);assert.equal(calls.filter(args=>args.some(arg=>arg.includes('/releases/tags/'))).length,1);
});

test('matching public releases are no-ops without rewriting tags or uploading assets',async t=>{
 for(const annotated of [false,true]){
  const f=fixture(t);await prepareRelease(f);const archive=path.join(f.output,'engine-1.0-arm64.tar.gz'),record=JSON.parse(fs.readFileSync(archive+'.json')),calls=[];
  const runGh=async args=>{calls.push(args);assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);if(args[1].includes('/git/ref/'))return refResult(annotated?annotation:sourceTarget,annotated?'tag':'commit');if(args[1].includes('/git/tags/'))return refResult();return JSON.stringify(remoteRelease(record));};
  const staged=await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});assert.equal(staged.draft,false);assert.equal(staged.draft,false);
  const published=await publishRelease({bundle:f.output,directory:f.directory,runGh});assert.equal(published.draft,false);assert.equal(published.draft,false);
  assert.equal(calls.some(args=>args[0]==='release'||args.includes('POST')),false);
 }
});
test('existing asset conflicts fail before any write',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
 const runGh=async args=>{assert.ok(!args.includes('POST'));if(args[1].includes('/git/ref/'))return refResult();const remote=remoteRelease(record);remote.assets[0].digest='sha256:'+'f'.repeat(64);return JSON.stringify(remote);};
 await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh}),/checksum differs/);
});
test('staging removes a failed draft and permits the same version in the next attempt',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});let draft,creates=0,uploads=0;
 const runGh=async args=>{
  const endpoint=args.find(arg=>arg.startsWith('repos/')||arg.startsWith('https://uploads.'));
  if(endpoint.includes('/git/ref/'))return refResult();
  if(endpoint.includes('/releases/tags/'))throw notFound();
  if(args.includes('--paginate'))return JSON.stringify([[...(draft?[draft]:[])]]);
  if(args.includes('DELETE')){assert.ok(endpoint.endsWith('/17'));draft=undefined;return '';}
  if(endpoint==='repos/owner/builds/releases'){creates++;draft={...remoteRelease(record,true),assets:[]};return JSON.stringify(draft);}
  assert.ok(endpoint.includes('/releases/17/assets?'));uploads++;if(uploads===1)throw Error('Connection interrupted after draft creation.');return JSON.stringify(remoteRelease(record).assets[0]);
 };
 await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,resume:true,directory:f.directory,runGh}),/Connection interrupted/);
 const result=await stageRelease({bundle:f.output,target:sourceTarget,resume:true,directory:f.directory,runGh});assert.equal(result.id,17);assert.equal(creates,2);assert.equal(uploads,2);
});

test('staging never fills an empty public release',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
 const runGh=async args=>{assert.equal(args[0],'api');assert.ok(!args.includes('POST'));if(args[1]?.includes('/git/ref/'))return refResult();return JSON.stringify({...remoteRelease(record),assets:[]});};
 await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,resume:true,directory:f.directory,runGh}),/differs/);
});

test('publishing patches only the verified draft ID and never uploads assets',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory}),calls=[];
 const runGh=async args=>{calls.push(args);if(args.includes('PATCH')){assert.ok(args.includes('repos/owner/builds/releases/17'));return JSON.stringify(remoteRelease(record));}return args[1].includes('/git/ref/')?refResult():JSON.stringify(remoteRelease(record,true));};
 const result=await publishRelease({bundle:f.output,directory:f.directory,runGh});assert.equal(result.draft,false);assert.equal(result.draft,false);assert.equal(calls.length,3);assert.ok(calls.every(args=>!args.includes('POST')));
});

test('staging never interprets an authentication or API failure as an absent tag',async t=>{
 const f=fixture(t);await prepareRelease(f);let calls=0;const failure=Object.assign(Error('authentication failed'),{stderr:'gh: Bad credentials (HTTP 401)'});
 await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh:async args=>{calls++;assert.equal(args[0],'api');throw failure;}}),error=>error===failure);assert.equal(calls,1);
});
test('remote verification rejects a cyclic source tag without any write',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});let calls=0;
 await assert.rejects(verifyRemoteRelease({bundle:f.output,directory:f.directory,runGh:async args=>{calls++;assert.equal(args[0],'api');assert.ok(!args.includes('POST'));return args[1].includes('/releases/tags/')?JSON.stringify(remoteRelease(record)):refResult(annotation,'tag');}}),/annotation chain is invalid/);assert.equal(calls,3);
});



test('catalog compatibility metadata survives archive verification and publication',async t=>{
 const f=fixture(t);await prepareRelease(f);const archive=path.join(f.output,'engine-1.0-arm64.tar.gz'),metadata={launcherContract:1,capabilities:{nativeApi:'entry-v1',nativeFeatures:['one','two'],resources:1},source:{repository:'owner/source',revision:'a'.repeat(40),path:'engine'}};
 const record={...JSON.parse(fs.readFileSync(archive+'.json')),...metadata};fs.writeFileSync(archive+'.json',JSON.stringify(record));
 const checked=await verifyRelease({bundle:f.output,directory:f.directory});for(const [key,value]of Object.entries(metadata))assert.deepEqual(checked.record[key],value);
 await applyRelease({bundle:f.output,directory:f.directory,runGh:publicReleaseGh(record)});
 const assets=path.join(f.directory,'metadata-assets');fs.mkdirSync(assets);fs.copyFileSync(archive,path.join(assets,path.basename(archive)));const restored=await verifyPublicAssets({project:f.project,version:'1.0',arch:'arm64',assets,directory:f.directory});for(const [key,value]of Object.entries(metadata))assert.deepEqual(restored.record[key],value);
 fs.writeFileSync(archive+'.json',JSON.stringify({...record,minimumMacOS:'14.0'}));await assert.rejects(verifyRelease({bundle:f.output,directory:f.directory}),/record differs/);
});


for(const state of ['missing','draft','checksum mismatch'])test('catalog application refuses a '+state+' release before writing catalogs',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
 const runGh=async args=>{assert.equal(args[0],'api');assert.ok(!args.includes('POST'));
  if(args[1].includes('/git/ref/'))return refResult();
  assert.ok(args[1].includes('/releases/tags/'));if(state==='missing')throw notFound();
  const remote=remoteRelease(record,state==='draft');if(state==='checksum mismatch')remote.assets[0].digest='sha256:'+'f'.repeat(64);return JSON.stringify(remote);
 };
 await assert.rejects(applyRelease({bundle:f.output,directory:f.directory,runGh}),state==='missing'?/not been staged/:state==='draft'?/public, non-draft/:/checksum differs/);assert.equal(fs.existsSync(path.join(f.directory,'catalogs')),false);
});

test('catalog application hashes a public asset when GitHub omits its digest',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
 let downloaded=false;
 const runGh=async(args,options)=>{
  assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);
  assert.equal(fs.existsSync(path.join(f.directory,'catalogs')),false);
  if(args[1].includes('/git/ref/'))return refResult();
  if(args[1].includes('/releases/tags/')){const remote=remoteRelease(record);delete remote.assets[0].digest;return JSON.stringify(remote);}
  assert.deepEqual(args,['api','repos/owner/builds/releases/assets/1','-H','Accept: application/octet-stream']);
  assert.equal(options.encoding,null);downloaded=true;return fs.readFileSync(path.join(f.output,record.asset.filename));
 };
 await applyRelease({bundle:f.output,directory:f.directory,runGh});assert.equal(downloaded,true);
 assert.equal(rawCatalog(f.directory).packages[0].version,'1.0');
});

// Minimal Mach-O executable headers: enough for inventory checks, never executed.
function machO(cpus){
 const thin=cpu=>{const b=Buffer.alloc(32);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE({arm64:0x0100000c,x86_64:0x01000007}[cpu],4);b.writeUInt32LE(2,12);return b;};
 if(cpus.length===1)return thin(cpus[0]);
 const header=Buffer.alloc(8+cpus.length*20);header.writeUInt32BE(0xcafebabe,0);header.writeUInt32BE(cpus.length,4);
 cpus.forEach((cpu,i)=>{header.writeUInt32BE({arm64:0x0100000c,x86_64:0x01000007}[cpu],8+i*20);header.writeUInt32BE(4096*(i+1),16+i*20);header.writeUInt32BE(32,20+i*20);});
 const bytes=Buffer.alloc(4096*(cpus.length+1));header.copy(bytes);cpus.forEach((cpu,i)=>thin(cpu).copy(bytes,4096*(i+1)));return bytes;
}
function managerOutput(directory,arch){
 const input=path.join(directory,'manager-'+arch),files=path.join(input,'files');fs.mkdirSync(path.join(files,'bin'),{recursive:true});
 const cpus=arch==='universal'?['arm64','x86_64']:[arch==='x64'?'x86_64':'arm64'],binary=machO(cpus);
 fs.writeFileSync(path.join(files,'bin/engine'),binary,{mode:0o755});fs.writeFileSync(path.join(files,'LICENSE'),'MIT',{mode:0o644});
 const revision='1'.repeat(40);
 fs.writeFileSync(path.join(input,'manifest.json'),JSON.stringify({schemaVersion:1,managerId:'engine',version:'1.0',upstreamRevision:revision,platform:'darwin',arch,minimumMacOS:'13.0',executableRelative:'bin/engine',
  files:[{path:'bin/engine',size:binary.length,mode:0o755,sha256:digest(binary),architectures:cpus},{path:'LICENSE',size:3,mode:0o644,sha256:digest('MIT')}],dependencies:[],notices:[{name:'Engine',license:'MIT',sourceUrl:'https://example.com/engine',path:'LICENSE'}],provenance:{sourceRevision:revision}}));
 return input;
}
test('manager outputs declare the Mac CPUs of their architecture',async t=>{
 const f=fixture(t),declared={};
 for(const arch of ['arm64','x64','universal'])declared[arch]=await managerDeclaration({project:'engine',input:managerOutput(f.directory,arch)});
 assert.deepEqual(declared.arm64.launcherArchitectures,['arm64']);assert.deepEqual(declared.universal.launcherArchitectures,['arm64','x64']);
 // Intel code also runs on Apple Silicon through Rosetta.
 assert.deepEqual(declared.x64.launcherArchitectures,['arm64','x64']);assert.equal(declared.x64.files.find(file=>file.path==='files/bin/engine').executionArchitecture,'x86_64');
});
test('remote verification compares a staged draft with its local package without changing GitHub',async t=>{
 const f=fixture(t);await prepareRelease(f);const record=JSON.parse(fs.readFileSync(path.join(f.output,'engine-1.0-arm64.tar.gz.json')));
 const draft=async args=>{assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);if(args[1].includes('/git/ref/'))return refResult();return JSON.stringify(remoteRelease(record,true));};
 const {publication}=await verifyRemoteRelease({bundle:f.output,directory:f.directory,runGh:draft});assert.equal(publication.draft,true);assert.equal(publication.sourceCommit,sourceTarget);
});

test('a failed publication removes its unpublished draft without deleting any public release',async t=>{
 for(const becamePublic of [false,true]){
  const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});const calls=[];
  const remote={...remoteRelease(record,true),assets:[]};
  const runGh=async args=>{
   calls.push(args);const endpoint=args.find(arg=>arg.startsWith('repos/')||arg.startsWith('https://uploads.'));
   if(endpoint.includes('/releases/tags/'))throw notFound();
   if(endpoint==='repos/owner/builds/releases')return JSON.stringify(remote);
   if(endpoint.startsWith('https://uploads.'))return JSON.stringify(remoteRelease(record).assets[0]);
   if(args.includes('PATCH'))throw Error('Resource not accessible by integration (HTTP 403)');
   if(args.includes('DELETE'))return '';
   assert.equal(endpoint,'repos/owner/builds/releases/17');return JSON.stringify({...remote,draft:!becamePublic});
  };
  const staged=await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});
  await assert.rejects(publishRelease({bundle:f.output,directory:f.directory,runGh,publication:staged,wait:async()=>{}}),/HTTP 403/);
  assert.equal(calls.filter(args=>args.includes('DELETE')).length,becamePublic?0:1);
 }
});

test('cataloging an identical public entry preserves existing row order',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
 const options={bundle:f.output,directory:f.directory,runGh:publicReleaseGh(record)};await applyRelease(options);
 const file=path.join(f.directory,'catalogs/engine.json'),before=JSON.parse(fs.readFileSync(file));
 const {catalog}=await import('../tools/runtime-package.mjs');
 const other={...record,arch:'x64',launcherArchitectures:['arm64','x64'],asset:{...record.asset,filename:'engine-1.0-x64.tar.gz'}};
 before.packages.unshift(catalog([other],{project:'engine',repository:'owner/builds',directory:f.directory}).packages[0]);fs.writeFileSync(file,JSON.stringify(before,null,2)+'\n');
 const bytes=fs.readFileSync(file);
 await applyRelease(options);assert.deepEqual(fs.readFileSync(file),bytes);
});

test('publication reads build inputs only after their archived bytes pass the sealed inventory',async t=>{
 const f=fixture(t),bytes=Buffer.from(JSON.stringify({schemaVersion:1,inputs:[]}));
 fs.writeFileSync(path.join(f.input,'build-inputs.json'),bytes,{mode:0o644});f.declaration.files.push({path:'build-inputs.json',size:bytes.length,mode:0o644,sha256:digest(bytes)});
 await prepareRelease(f);const checked=await verifyRelease({bundle:f.output,directory:f.directory,includeMetadata:true});
 assert.deepEqual(checked.metadata['build-inputs.json'],bytes);
});

test('catalog envelope and runtime row retain the fc173327 format',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});const {catalog}=await import('../tools/runtime-package.mjs');
 const expected={schemaVersion:2,projectId:'engine',updatePolicy:'manual',packages:[{...record,tag:'engine/v1.0/arm64',asset:{...record.asset,url:'https://github.com/owner/builds/releases/download/engine%2Fv1.0%2Farm64/engine-1.0-arm64.tar.gz'}}]};
 assert.equal(JSON.stringify(catalog([record],{project:'engine',repository:'owner/builds',directory:f.directory})),JSON.stringify(expected));
});

 test('release finalization retries transient 422 responses and cleans up after exhaustion',async t=>{
 for(const failures of [2,5]){
  const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
  let attempts=0,deletes=0;const delays=[],errors=[];const remote={...remoteRelease(record,true),assets:[]};
  const runGh=async args=>{
   const endpoint=args.find(arg=>arg.startsWith('repos/')||arg.startsWith('https://uploads.'));
   if(endpoint.includes('/releases/tags/'))throw notFound();
   if(endpoint==='repos/owner/builds/releases')return JSON.stringify(remote);
   if(endpoint.startsWith('https://uploads.'))return JSON.stringify(remoteRelease(record).assets[0]);
   if(args.includes('PATCH')){attempts++;if(attempts<=failures){const error=Error('Validation Failed (HTTP 422), attempt '+attempts);errors.push(error);throw error;}return JSON.stringify(remoteRelease(record));}
   if(args.includes('DELETE')){deletes++;return '';}
   assert.equal(endpoint,'repos/owner/builds/releases/17');return JSON.stringify(remote);
  };
  const publication=await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});
  const operation=publishRelease({bundle:f.output,directory:f.directory,runGh,publication,wait:async ms=>delays.push(ms)});
  if(failures===2){assert.equal((await operation).draft,false);assert.equal(attempts,3);assert.equal(deletes,0);assert.deepEqual(delays,[1000,2000]);}
  else{await assert.rejects(operation,error=>error===errors[4]);assert.equal(attempts,5);assert.equal(deletes,1);assert.deepEqual(delays,[1000,2000,4000,8000]);}
 }
});
