import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareRelease,verifyRelease,applyRelease as actualApplyRelease,publicationAssets,verifyPublicAssets,stageRelease as actualStageRelease,publishRelease as actualPublishRelease,managerDeclaration,verifyRemoteRelease as actualVerifyRemoteRelease,main} from '../tools/release-runtime.mjs';
import {releaseBatch as actualReleaseBatch,main as actualBatchMain} from '../tools/release-batch.mjs';
// Synthetic remote-release lifecycle tests inject only the cryptographic boundary.
const fixtureBuild=({record,repository,directory,archive,sourceRevision})=>{
 assert.equal(repository,'owner/builds');assert.ok(fs.statSync(directory).isDirectory());
 assert.equal(digest(fs.readFileSync(archive)),record.asset.sha256);assert.equal(path.basename(archive),record.asset.filename);
 if(sourceRevision!==undefined)assert.equal(sourceRevision,'a'.repeat(40));
 return {sourceRevision:'a'.repeat(40)};
};
const stageRelease=o=>actualStageRelease({...o,verifyGithubBuild:fixtureBuild});
const publishRelease=o=>actualPublishRelease({...o,verifyGithubBuild:fixtureBuild});
const verifyRemoteRelease=o=>actualVerifyRemoteRelease({...o,verifyGithubBuild:fixtureBuild});
const applyRelease=o=>actualApplyRelease({...o,verifyGithubBuild:fixtureBuild});
const releaseBatch=o=>actualReleaseBatch({...o,verifyGithubBuild:fixtureBuild});
const batchMain=(args,o)=>actualBatchMain(args,{...o,verifyGithubBuild:fixtureBuild});
const rawCatalog=directory=>JSON.parse(fs.readFileSync(path.join(directory,'catalogs/engine.json')));
const supersededCatalog=directory=>{const file=path.join(directory,'catalogs/superseded/engine.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{packages:[]};};
const catalogHistory=directory=>[...rawCatalog(directory).packages,...supersededCatalog(directory).packages];
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
test('publication refuses absent and forged signed evidence before remote or catalog writes',async t=>{
 const f=fixture(t);await prepareRelease(f);
 const archive=path.join(f.output,'engine-1.0-arm64.tar.gz'),record=JSON.parse(fs.readFileSync(archive+'.json'));
 const forged={...record,build:{sourceRevision:'a'.repeat(40),workflow:'owner/builds/.github/workflows/runtime-build.yml',runId:'123',runAttempt:'1'}};
 const bundle=path.join(f.directory,'forged');await prepareRelease({project:f.project,archive,record:forged,output:bundle,directory:f.directory});
 let calls=0;const runGh=()=>{calls++;throw Error('Unsigned packages must not contact GitHub.');};
 for(const operation of [actualStageRelease,actualPublishRelease,actualApplyRelease,actualVerifyRemoteRelease]){
  await assert.rejects(operation({bundle,target:'a'.repeat(40),directory:f.directory,runGh}),/GitHub|signed|attestation|provenance/i);
  assert.equal(calls,0);assert.equal(fs.existsSync(path.join(f.directory,'catalogs')),false);
 }
 fs.mkdirSync(path.join(f.directory,'attestations'));
 fs.writeFileSync(path.join(f.directory,'attestations',record.asset.sha256+'.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',sourceRevision:'a'.repeat(40),runId:'123',sha256:record.asset.sha256,verified:true}));
 await assert.rejects(actualStageRelease({bundle,target:'a'.repeat(40),directory:f.directory,runGh}),/GitHub|signed|attestation|provenance|evidence|bundle/i);
 assert.equal(calls,0);
});
test('publication binds the signed build to the requested and existing tag commit',async t=>{
 const f=fixture(t);await prepareRelease(f);let calls=0;
 await assert.rejects(actualStageRelease({bundle:f.output,target:'a'.repeat(40),directory:f.directory,verifyGithubBuild:()=>({sourceRevision:'b'.repeat(40)}),runGh:()=>{calls++;}}),/source commit differs/);
 assert.equal(calls,0);
 const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
 const runGh=async args=>{calls++;assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);return args[1].includes('/git/ref/')?refResult('b'.repeat(40)):JSON.stringify([[remoteRelease(record,true)]]);};
 await assert.rejects(publishRelease({bundle:f.output,directory:f.directory,runGh}),/source commit differs/);
 assert.equal(calls,2);
});
test('catalog publication CLI refuses an unproven record before creating its output',async t=>{
 const {main:packageMain}=await import('../tools/runtime-package.mjs');
 const f=fixture(t),catalog=JSON.parse(fs.readFileSync(new URL('../catalogs/vnds-love.json',import.meta.url)));
 const record={...catalog.packages[0],asset:{...catalog.packages[0].asset,sha256:'f'.repeat(64)}};
 const input=path.join(f.directory,'record.json'),output=path.join(f.directory,'published/vnds-love.json');fs.writeFileSync(input,JSON.stringify(record));
 await assert.rejects(packageMain(['catalog','--project','vnds-love','--package',input,'--output',output]),/GitHub|signed|attestation|provenance/i);
 assert.equal(fs.existsSync(path.dirname(output)),false);
});

test('one selected release prepares offline and applies an independently discoverable catalog',async t=>{
 const f=fixture(t),r=await prepareRelease(f);assert.equal(r.tag,'engine/v1.0/arm64');assert.equal(r.assets.length,3);
 const checked=await verifyRelease({bundle:f.output,directory:f.directory,project:'engine',version:'1.0',arch:'arm64'});assert.equal(checked.record.version,'1.0');
 await assert.rejects(verifyRelease({bundle:f.output,directory:f.directory,project:'other'}),/differs/);
 await applyRelease({bundle:f.output,directory:f.directory,runGh:publicReleaseGh(checked.record)});assert.equal(rawCatalog(f.directory).packages[0].version,'1.0');
 await assert.rejects(prepareRelease(f),/new release output/);
 fs.writeFileSync(path.join(f.output,'unexpected.txt'),'extra');await assert.rejects(verifyRelease({bundle:f.output,directory:f.directory}),/undeclared/);
});
test('optional local source validation never adds a public source attachment',async t=>{
 const f=fixture(t,{external:true});await prepareRelease(f);const checked=await verifyRelease({bundle:f.output,directory:f.directory});
 assert.equal(checked.record.sourceAsset,undefined);assert.deepEqual(publicationAssets(checked.release),['engine-1.0-arm64.tar.gz']);
 fs.writeFileSync(path.join(f.output,'1.0-source.tar.gz'),'changed');await assert.rejects(verifyRelease({bundle:f.output,directory:f.directory}),/checksum or size/);
});
test('existing archives are reused and altered sidecar metadata is rejected',async t=>{
 const f=fixture(t);await prepareRelease(f);const archive=path.join(f.output,'engine-1.0-arm64.tar.gz'),record=JSON.parse(fs.readFileSync(archive+'.json'));
 const next=path.join(f.directory,'reuse');await prepareRelease({project:f.project,archive,record,output:next,directory:f.directory});assert.deepEqual(fs.readFileSync(path.join(next,path.basename(archive))),fs.readFileSync(archive));
 await assert.rejects(prepareRelease({project:f.project,archive,record:{...record,minimumMacOS:'14.0'},output:path.join(f.directory,'altered'),directory:f.directory}),/record differs/);
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
 const workflow=fs.readFileSync(new URL('../.github/workflows/runtime-release.yml',import.meta.url),'utf8');
 const block=workflow.match(/      - name: Verify release source commit\n        if: inputs.operation != 'stage'\n        run: \|\n((?:          [^\n]*\n)+)/)?.[1];assert.ok(block,'Tagged-source workflow step exists');
 const command=block.trimEnd().split('\n').map(line=>line.slice(10)).join('\n');
 const controller=git(checkout,['rev-parse','HEAD']),githubEnv=path.join(directory,'github-env');
 execFileSync('/bin/bash',['-eu','-c',command],{cwd:checkout,env:{...env,RELEASE_TAG:tag,GITHUB_ENV:githubEnv},stdio:'pipe'});
 assert.equal(git(checkout,['rev-parse','HEAD']),controller);assert.equal(fs.readFileSync(path.join(checkout,'projects.json'),'utf8'),'different dispatch branch source');
 assert.equal(fs.readFileSync(githubEnv,'utf8'),'RELEASE_SOURCE_REVISION='+tagged+'\n');
});

const sourceTarget='a'.repeat(40),annotation='b'.repeat(40);
const refResult=(sha=sourceTarget,type='commit')=>JSON.stringify({object:{sha,type}});
const notFound=()=>Object.assign(Error('ref missing'),{stderr:'gh: Not Found (HTTP 404)'});
const remoteRelease=(record,draft=false)=>({tag_name:record.id+'/v'+record.version+'/'+record.arch,draft,assets:[{id:1,name:record.asset.filename,size:record.asset.bytes,state:'uploaded',digest:'sha256:'+record.asset.sha256}]});
function publicReleaseGh(record){return async args=>{
 assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);
 if(args[1].includes('/git/ref/'))return refResult();
 assert.deepEqual(args,['api','--paginate','--slurp','repos/owner/builds/releases?per_page=100']);
 return JSON.stringify([[remoteRelease(record)]]);
};}
test('staging creates a new exact source tag and uploads one draft binary',async t=>{
 const f=fixture(t,{external:true});await prepareRelease(f);const calls=[];
 const runGh=async(args,options)=>{calls.push(args);if(args[1]?.includes('/git/ref/'))throw notFound();if(args.includes('--paginate'))return '[]';if(args[0]==='api'){assert.ok(args.includes('POST'));return refResult();}assert.equal(options.stdio,'inherit');return '';};
 const result=await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});
 assert.deepEqual(result,{repository:'owner/builds',tag:'engine/v1.0/arm64',draft:true});assert.equal(calls.length,4);
 const upload=calls[3];assert.deepEqual(upload.slice(0,9),['release','create','engine/v1.0/arm64','--repo','owner/builds','--draft','--verify-tag','--latest=false','--target']);
 assert.equal(upload[9],sourceTarget);assert.deepEqual(upload.filter(arg=>arg.startsWith(f.output)),[path.join(f.output,'engine-1.0-arm64.tar.gz')]);
});
test('matching releases and local preparation are no-ops without rewriting tags or uploading assets',async t=>{
 for(const annotated of [false,true]){
  const f=fixture(t);await prepareRelease(f);const archive=path.join(f.output,'engine-1.0-arm64.tar.gz'),record=JSON.parse(fs.readFileSync(archive+'.json')),calls=[];
  const local=await prepareRelease({project:f.project,archive,record,output:f.output,directory:f.directory});assert.equal(local.existing,true);
  const runGh=async args=>{calls.push(args);assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);if(args[1].includes('/git/ref/'))return refResult(annotated?annotation:sourceTarget,annotated?'tag':'commit');if(args[1].includes('/git/tags/'))return refResult();return JSON.stringify([[remoteRelease(record)]]);};
  const staged=await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});assert.equal(staged.existing,true);assert.equal(staged.draft,false);
  const published=await publishRelease({bundle:f.output,directory:f.directory,runGh});assert.equal(published.existing,true);assert.equal(published.draft,false);
  assert.equal(calls.some(args=>args[0]==='release'||args.includes('POST')),false);
 }
});
test('existing asset conflicts and orphan tags fail before any write',async t=>{
 for(const orphan of [false,true]){
  const f=fixture(t);await prepareRelease(f);const record=JSON.parse(fs.readFileSync(path.join(f.output,'engine-1.0-arm64.tar.gz.json'))),calls=[];
  const runGh=async args=>{calls.push(args);assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);if(args[1].includes('/git/ref/'))return refResult();if(orphan)return '[]';const remote=remoteRelease(record);remote.assets[0].digest='sha256:'+'f'.repeat(64);return JSON.stringify([[remote]]);};
  await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh}),orphan?/identity is incomplete/:/checksum differs/);
  assert.equal(calls.length,2);
 }
});
test('publishing changes only a verified draft status and never uploads assets',async t=>{
 const f=fixture(t);await prepareRelease(f);const record=JSON.parse(fs.readFileSync(path.join(f.output,'engine-1.0-arm64.tar.gz.json'))),calls=[];
 const runGh=async args=>{calls.push(args);if(args[0]==='api')return args[1].includes('/git/ref/')?refResult():JSON.stringify([[remoteRelease(record,true)]]);assert.deepEqual(args,['release','edit','engine/v1.0/arm64','--repo','owner/builds','--draft=false','--latest=false']);return '';};
 const result=await publishRelease({bundle:f.output,directory:f.directory,runGh});assert.equal(result.published,true);assert.equal(result.draft,false);assert.equal(calls.length,3);
});
test('staging never interprets an authentication or API failure as an absent tag',async t=>{
 const f=fixture(t);await prepareRelease(f);let calls=0;const failure=Object.assign(Error('authentication failed'),{stderr:'gh: Bad credentials (HTTP 401)'});
 await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh:async args=>{calls++;assert.equal(args[0],'api');throw failure;}}),error=>error===failure);assert.equal(calls,1);
});
test('staging rejects a cyclic annotation chain without creating a release',async t=>{
 const f=fixture(t);await prepareRelease(f);let calls=0;
 await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh:async args=>{calls++;assert.equal(args[0],'api');return refResult(annotation,'tag');}}),/annotation chain is invalid/);assert.equal(calls,2);
});
test('source push CI selects main without scheduling runtime tag jobs',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/source.yml',import.meta.url),'utf8');
 assert.match(workflow,/on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:/);
 assert.doesNotMatch(workflow,/\n    tags:/);
});


test('catalog compatibility metadata survives sealed preparation and public asset verification',async t=>{
 const f=fixture(t);await prepareRelease(f);
 const archive=path.join(f.output,'engine-1.0-arm64.tar.gz');
 const metadata={launcherContract:1,capabilities:{nativeApi:'entry-v1',nativeFeatures:['one','two'],resources:1},source:{repository:'owner/source',revision:'a'.repeat(40),path:'engine'}};
 const record={...JSON.parse(fs.readFileSync(archive+'.json')),...metadata},output=path.join(f.directory,'metadata-release');
 await prepareRelease({project:f.project,archive,record,output,directory:f.directory});
 const checked=await verifyRelease({bundle:output,directory:f.directory});
 for(const [key,value] of Object.entries(metadata))assert.deepEqual(checked.record[key],value);
 assert.deepEqual(fs.readFileSync(path.join(output,path.basename(archive))),fs.readFileSync(archive));
 await applyRelease({bundle:output,directory:f.directory,runGh:publicReleaseGh(checked.record)});
 const assets=path.join(f.directory,'metadata-assets');fs.mkdirSync(assets);fs.copyFileSync(archive,path.join(assets,path.basename(archive)));
 await verifyPublicAssets({project:f.project,version:'1.0',arch:'arm64',assets,output:path.join(f.directory,'public-metadata'),directory:f.directory});
 const restored=await verifyRelease({bundle:path.join(f.directory,'public-metadata'),directory:f.directory});
 for(const [key,value] of Object.entries(metadata))assert.deepEqual(restored.record[key],value);
 await assert.rejects(prepareRelease({project:f.project,archive,record:{...record,minimumMacOS:'14.0'},output:path.join(f.directory,'changed-payload'),directory:f.directory}),/record differs/);
 await assert.rejects(prepareRelease({project:f.project,archive,record:{...record,unknownField:true},output:path.join(f.directory,'unknown-metadata'),directory:f.directory}),/Invalid runtime release record/);
});


test('a draft found only in the authenticated paginated release list finalizes without restaging',async t=>{
 const f=fixture(t);await prepareRelease(f);const record=JSON.parse(fs.readFileSync(path.join(f.output,'engine-1.0-arm64.tar.gz.json'))),calls=[];
 const runGh=async args=>{calls.push(args);if(args[0]==='api'){if(args[1].includes('/git/ref/'))return refResult();assert.deepEqual(args,['api','--paginate','--slurp','repos/owner/builds/releases?per_page=100']);return JSON.stringify([[],[remoteRelease(record,true)]]);}assert.deepEqual(args,['release','edit','engine/v1.0/arm64','--repo','owner/builds','--draft=false','--latest=false']);return '';};
 const staged=await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});assert.equal(staged.existing,true);assert.equal(staged.draft,true);assert.equal(calls.length,2);
 const published=await publishRelease({bundle:f.output,directory:f.directory,runGh});assert.equal(published.published,true);assert.equal(calls.length,5);assert.equal(calls.some(args=>args.includes('create')||args.includes('upload')||args.includes('POST')),false);
});

for(const state of ['missing','draft','checksum mismatch']){
 test('catalog application refuses a '+state+' release before writing catalogs',async t=>{
  const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
  const runGh=async args=>{
   assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);
   if(args[1].includes('/git/ref/')){if(state==='missing')throw notFound();return refResult();}
   assert.deepEqual(args,['api','--paginate','--slurp','repos/owner/builds/releases?per_page=100']);
   if(state==='missing')return '[]';
   const remote=remoteRelease(record,state==='draft');
   if(state==='checksum mismatch')remote.assets[0].digest='sha256:'+'f'.repeat(64);
   return JSON.stringify([[remote]]);
  };
  await assert.rejects(applyRelease({bundle:f.output,directory:f.directory,runGh}),state==='missing'?/not been staged/:state==='draft'?/public, non-draft/:/checksum differs/);
  assert.equal(fs.existsSync(path.join(f.directory,'catalogs')),false);
 });
}
test('catalog application hashes a public asset when GitHub omits its digest',async t=>{
 const f=fixture(t);await prepareRelease(f);const {record}=await verifyRelease({bundle:f.output,directory:f.directory});
 let downloaded=false;
 const runGh=async(args,options)=>{
  assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);
  assert.equal(fs.existsSync(path.join(f.directory,'catalogs')),false);
  if(args[1].includes('/git/ref/'))return refResult();
  if(args.includes('--paginate')){const remote=remoteRelease(record);delete remote.assets[0].digest;return JSON.stringify([[remote]]);}
  assert.deepEqual(args,['api','repos/owner/builds/releases/assets/1','-H','Accept: application/octet-stream']);
  assert.equal(options.encoding,null);downloaded=true;return fs.readFileSync(path.join(f.output,record.asset.filename));
 };
 await applyRelease({bundle:f.output,directory:f.directory,runGh});assert.equal(downloaded,true);
 assert.equal(rawCatalog(f.directory).packages[0].version,'1.0');
});

async function batchFixture(t){
 const fixtures=[];
 for(const version of ['1.0','2.0','3.0']){
  const f=fixture(t,{version});await prepareRelease(f);
  fixtures.push({...f,...await verifyRelease({bundle:f.output,directory:f.directory})});
 }
 const directory=fixtures[0].directory,file=path.join(directory,'projects.json'),registry=JSON.parse(fs.readFileSync(file));
 registry.projects[0].packageProfiles=fixtures.map(f=>({version:f.record.version,label:'Engine '+f.record.version}));
 fs.writeFileSync(file,JSON.stringify(registry));
 return {directory,output:path.join(directory,'batch-output'),packages:fixtures.map(f=>f.output),records:fixtures.map(f=>f.record)};
}
function batchGitHub(f,{existing=[],badUpload=false}={}){
 const records=new Map(f.records.map(r=>[remoteRelease(r).tag_name,r])),releases=new Map(existing.map(r=>[r.tag_name,structuredClone(r)])),refs=new Set(releases.keys()),calls=[];
 const runGh=async args=>{
  calls.push(args);
  if(args[0]==='api'){
   if(args.includes('--paginate'))return JSON.stringify([[...releases.values()]]);
   if(args[1].includes('/git/ref/')){
    const tag=args[1].split('/git/ref/tags/')[1];if(!refs.has(tag))throw notFound();return refResult();
   }
   assert.deepEqual(args.slice(0,4),['api','--method','POST','repos/owner/builds/git/refs']);
   const tag=args.find(a=>a.startsWith('ref=refs/tags/')).slice('ref=refs/tags/'.length);
   assert.ok(records.has(tag));assert.equal(refs.has(tag),false);assert.ok(args.includes('sha='+sourceTarget));refs.add(tag);return refResult();
  }
  assert.equal(args[0],'release');
  const tag=args[2],record=records.get(tag);assert.ok(record);
  const catalog=path.join(f.directory,'catalogs','engine.json');
  if(fs.existsSync(catalog))assert.equal(JSON.parse(fs.readFileSync(catalog)).packages.some(r=>r.version===record.version),false,'Catalog row must wait for publication.');
  if(args[1]==='create'){
   assert.equal(releases.has(tag),false);assert.ok(args.includes('--draft'));
   const archive=fs.readFileSync(args.at(-1));assert.equal(digest(archive),record.asset.sha256);assert.equal(archive.length,record.asset.bytes);
   const remote=remoteRelease(record,true);if(badUpload)remote.assets[0].digest='sha256:'+'f'.repeat(64);releases.set(tag,remote);return '';
  }
  assert.deepEqual(args,['release','edit',tag,'--repo','owner/builds','--draft=false','--latest=false']);
  assert.equal(releases.get(tag).draft,true);releases.get(tag).draft=false;return '';
 };
 return {runGh,calls,releases};
}
const writes=calls=>calls.filter(args=>args[0]==='release'||args.includes('POST'));
test('batch CLI releases in order, applies public catalogs and never reuploads on rerun',async t=>{
 const f=await batchFixture(t),remote=batchGitHub(f,{existing:[remoteRelease(f.records[1])]}),args=['--target',sourceTarget,'--output',f.output,...f.packages.flatMap(p=>['--package',p])];
 const results=await batchMain(args,{directory:f.directory,runGh:remote.runGh});
 assert.deepEqual(results.map(r=>r.published),[true,false,true]);
 const tags=f.records.map(r=>remoteRelease(r).tag_name);
 assert.deepEqual(writes(remote.calls).map(args=>args[0]==='api'?args.find(a=>a.startsWith('ref=refs/tags/')).slice('ref=refs/tags/'.length):args[2]),[tags[0],tags[0],tags[0],tags[2],tags[2],tags[2]]);
 assert.deepEqual(new Set(catalogHistory(f.directory).map(r=>r.version)),new Set(['1.0','2.0','3.0']));
 assert.deepEqual(rawCatalog(f.directory).packages.map(r=>r.version),['3.0']);
 assert.deepEqual(new Set(supersededCatalog(f.directory).packages.map(r=>r.version)),new Set(['1.0','2.0']));
 for(const [i,result] of results.entries())assert.equal(digest(fs.readFileSync(path.join(result.bundle,f.records[i].asset.filename))),f.records[i].asset.sha256);
 const count=remote.calls.length,again=await batchMain(args,{directory:f.directory,runGh:remote.runGh});
 assert.deepEqual(again.map(r=>r.published),[false,false,false]);assert.deepEqual(writes(remote.calls.slice(count)),[]);
});
test('a batch asset mismatch stops before preparing or contacting later packages',async t=>{
 const f=await batchFixture(t),conflict=remoteRelease(f.records[1]);conflict.assets[0].digest='sha256:'+'f'.repeat(64);
 const remote=batchGitHub(f,{existing:[conflict]});
 await assert.rejects(releaseBatch({...f,target:sourceTarget,runGh:remote.runGh}),/checksum differs/);
 assert.deepEqual(rawCatalog(f.directory).packages.map(r=>r.version),['1.0']);
 assert.equal(fs.existsSync(path.join(f.output,'engine','3.0')),false);
 assert.equal(remote.calls.some(args=>args.some(a=>a.includes('engine/v3.0/arm64'))),false);
 assert.deepEqual(writes(remote.calls).filter(args=>args[0]==='release').map(args=>args[2]),['engine/v1.0/arm64','engine/v1.0/arm64']);
});
test('batch resumes an identical draft without a tag write or archive upload',async t=>{
 const f=await batchFixture(t),remote=batchGitHub(f,{existing:[remoteRelease(f.records[0],true)]});
 const results=await releaseBatch({...f,packages:f.packages.slice(0,1),target:sourceTarget,runGh:remote.runGh});
 assert.equal(results[0].published,true);
 assert.deepEqual(writes(remote.calls),[['release','edit','engine/v1.0/arm64','--repo','owner/builds','--draft=false','--latest=false']]);
});
test('batch verifies a newly staged asset before publication and leaves later packages untouched',async t=>{
 const f=await batchFixture(t),remote=batchGitHub(f,{badUpload:true});
 await assert.rejects(releaseBatch({...f,target:sourceTarget,runGh:remote.runGh}),/checksum differs/);
 assert.equal(remote.releases.get('engine/v1.0/arm64').draft,true);
 assert.equal(writes(remote.calls).some(args=>args[1]==='edit'),false);
 assert.equal(fs.existsSync(path.join(f.directory,'catalogs')),false);
 assert.equal(fs.existsSync(path.join(f.output,'engine','2.0')),false);
});
test('batch CLI rejects incomplete or ambiguous options before GitHub calls',async()=>{
 const runGh=()=>assert.fail('Invalid options must not contact GitHub.');
 for(const args of [[],['--package'],['--target',sourceTarget,'--target',sourceTarget],['--unknown','value']])await assert.rejects(batchMain(args,{runGh}),/requires|Use/);
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
 await assert.rejects(main(['verify-remote']),/--bundle/);await assert.rejects(main(['verify-remote','--bundle','x','--target','y']),/explicit options/);
 const f=fixture(t);await prepareRelease(f);const record=JSON.parse(fs.readFileSync(path.join(f.output,'engine-1.0-arm64.tar.gz.json')));
 const draft=async args=>{assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);if(args[1].includes('/git/ref/'))return refResult();return JSON.stringify([[remoteRelease(record,true)]]);};
 const {publication}=await verifyRemoteRelease({bundle:f.output,directory:f.directory,runGh:draft});assert.equal(publication.draft,true);assert.equal(publication.sourceCommit,sourceTarget);
});
