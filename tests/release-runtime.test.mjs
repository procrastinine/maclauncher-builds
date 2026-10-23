import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareRelease,verifyRelease,applyRelease,catalogIndex,publicationAssets,verifyPublicAssets,stageRelease,main} from '../tools/release-runtime.mjs';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t,{external=false}={}){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'runtime-release-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[{id:'engine',name:'Engine',producer:{kind:'prebuilt',version:'1.0',architectures:['arm64']},upstreams:[]}]}));
 const input=path.join(directory,'input');fs.mkdirSync(input);
 const data={'runtime.json':'{"version":"1.0"}','LICENSE':'MIT','source.tar.gz':'source bytes'};
 if(external)delete data['source.tar.gz'];
 const files=Object.entries(data).map(([name,bytes])=>{fs.writeFileSync(path.join(input,name),bytes,{mode:0o644});return {path:name,size:Buffer.byteLength(bytes),mode:0o644,sha256:digest(bytes)};});
 const declaration={id:'engine',version:'1.0',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',directoryRelative:'engine/1.0/arm64',manifestRelative:'runtime.json',manifestSha256:files[0].sha256,sourceSha256:digest('source bytes'),files,notices:[{name:'Engine',license:'MIT',path:'LICENSE'}],redistribution:'bundle'};
 let source;if(external){source=path.join(directory,'source.tar.gz');fs.writeFileSync(source,'source bytes');declaration.sourceArtifact={directoryRelative:'engine/1.0-source.tar.gz',sha256:digest('source bytes'),bytes:12};}else declaration.sourceRelative='source.tar.gz';
 return {project:'engine',input,declaration,source,output:path.join(directory,'release'),directory};
}
test('one selected release prepares offline and applies an independently discoverable catalog',async t=>{
 const f=fixture(t),r=await prepareRelease(f);assert.equal(r.tag,'engine/v1.0/arm64');assert.equal(r.assets.length,3);
 const checked=await verifyRelease({bundle:f.output,directory:f.directory,project:'engine',version:'1.0',arch:'arm64'});assert.equal(checked.record.version,'1.0');
 await assert.rejects(verifyRelease({bundle:f.output,directory:f.directory,project:'other'}),/differs/);
 await applyRelease({bundle:f.output,directory:f.directory});const index=catalogIndex(f.directory);assert.equal(index.projects[0].catalog.url,'https://raw.githubusercontent.com/owner/builds/main/catalogs/engine.json');
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
 await applyRelease({bundle:f.output,directory:f.directory});
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

test('manual release verification checks out the selected tag instead of the dispatch branch',t=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'runtime-tag-source-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const upstream=path.join(directory,'upstream'),checkout=path.join(directory,'checkout');fs.mkdirSync(upstream);
 const env={...process.env,GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
 const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(upstream,['init','--initial-branch=main']);fs.writeFileSync(path.join(upstream,'projects.json'),'tagged catalog source');git(upstream,['add','projects.json']);git(upstream,['commit','-m','Tagged source']);
 const tagged=git(upstream,['rev-parse','HEAD']),tag='engine/v1.0/arm64';git(upstream,['tag',tag]);
 fs.writeFileSync(path.join(upstream,'projects.json'),'different dispatch branch source');git(upstream,['add','projects.json']);git(upstream,['commit','-m','Later branch source']);
 execFileSync('git',['clone','--quiet','--no-hardlinks',upstream,checkout],{env,stdio:'pipe'});assert.notEqual(git(checkout,['rev-parse','HEAD']),tagged);
 const workflow=fs.readFileSync(new URL('../.github/workflows/runtime-release.yml',import.meta.url),'utf8');
 const block=workflow.match(/      - name: Verify release source commit\n        run: \|\n((?:          [^\n]*\n)+)/)?.[1];assert.ok(block,'Tagged-source workflow step exists');
 const command=block.trimEnd().split('\n').map(line=>line.slice(10)).join('\n');
 execFileSync('/bin/bash',['-eu','-c',command],{cwd:checkout,env:{...env,RELEASE_TAG:tag},stdio:'pipe'});
 assert.equal(git(checkout,['rev-parse','HEAD']),tagged);assert.equal(fs.readFileSync(path.join(checkout,'projects.json'),'utf8'),'tagged catalog source');
});

const sourceTarget='a'.repeat(40),annotation='b'.repeat(40);
const refResult=(sha=sourceTarget,type='commit')=>JSON.stringify({object:{sha,type}});
const notFound=()=>Object.assign(Error('ref missing'),{stderr:'gh: Not Found (HTTP 404)'});
test('staging creates the exact source tag before uploading one draft binary',async t=>{
 const f=fixture(t,{external:true});await prepareRelease(f);const calls=[];
 const runGh=async(args,options)=>{
  calls.push(args);
  if(calls.length===1){assert.deepEqual(args,['api','repos/owner/builds/git/ref/tags/engine/v1.0/arm64']);throw notFound();}
  if(calls.length===2){assert.deepEqual(args,['api','--method','POST','repos/owner/builds/git/refs','-f','ref=refs/tags/engine/v1.0/arm64','-f','sha='+sourceTarget]);return refResult();}
  assert.equal(options.stdio,'inherit');return '';
 };
 const result=await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});
 assert.deepEqual(result,{repository:'owner/builds',tag:'engine/v1.0/arm64',draft:true});assert.equal(calls.length,3);
 const upload=calls[2];assert.deepEqual(upload.slice(0,9),['release','create','engine/v1.0/arm64','--repo','owner/builds','--draft','--verify-tag','--latest=false','--target']);
 assert.equal(upload[9],sourceTarget);assert.deepEqual(upload.filter(arg=>arg.startsWith(f.output)),[path.join(f.output,'engine-1.0-arm64.tar.gz')]);
});
test('staging reuses exact lightweight and annotated source tags without rewriting them',async t=>{
 for(const annotated of [false,true]){
  const f=fixture(t);await prepareRelease(f);const calls=[];
  const runGh=async args=>{
   calls.push(args);
   if(args[0]==='release')return '';
   if(calls.length===1)return refResult(annotated?annotation:sourceTarget,annotated?'tag':'commit');
   assert.deepEqual(args,['api','repos/owner/builds/git/tags/'+annotation]);return refResult();
  };
  await stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh});
  assert.equal(calls.length,annotated?3:2);assert.equal(calls.some(args=>args.includes('POST')),false);
 }
});
test('staging refuses conflicting lightweight and annotated tags before any write',async t=>{
 for(const annotated of [false,true]){
  const f=fixture(t);await prepareRelease(f);const calls=[];
  const runGh=async args=>{calls.push(args);assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);return refResult(annotation,annotated&&calls.length===1?'tag':'commit');};
  await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh}),/differs from the exact source commit/);
  assert.equal(calls.length,annotated?2:1);
 }
});
test('staging never interprets an authentication or API failure as an absent tag',async t=>{
 const f=fixture(t);await prepareRelease(f);let calls=0;const failure=Object.assign(Error('authentication failed'),{stderr:'gh: Bad credentials (HTTP 401)'});
 await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh:async args=>{calls++;assert.equal(args[0],'api');throw failure;}}),error=>error===failure);
 assert.equal(calls,1);
});
test('staging rejects a cyclic annotation chain without creating a release',async t=>{
 const f=fixture(t);await prepareRelease(f);let calls=0;
 await assert.rejects(stageRelease({bundle:f.output,target:sourceTarget,directory:f.directory,runGh:async args=>{calls++;assert.equal(args[0],'api');return refResult(annotation,'tag');}}),/annotation chain is invalid/);
 assert.equal(calls,2);
});
test('source push CI selects main without scheduling runtime tag jobs',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/source.yml',import.meta.url),'utf8');
 assert.match(workflow,/on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:/);
 assert.doesNotMatch(workflow,/\n    tags:/);
});
