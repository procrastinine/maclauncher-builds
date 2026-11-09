import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareRelease,verifyRelease,stageRelease,publishRelease} from '../tools/release-runtime.mjs';
import {publishLevel} from '../tools/publish-level.mjs';
import {appendPackageCatalog} from '../tools/publish-package.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),source='a'.repeat(40),repository='procrastinine/maclauncher-builds';
const identity={GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
const git=(cwd,args)=>execFileSync('git',args,{cwd,env:{...process.env,...identity},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(t,id='engine',version='1.0.0',arch='arm64'){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'publication-failure-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const project={id,name:'Engine',delivery:'downloadable',producer:{kind:'prebuilt',version,architectures:[arch==='universal'?'arm64':arch]},upstreams:[],packageProfiles:[{version,label:'Engine'},{version:'3.0.1',label:'Next'}]};
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository,updatePolicy:'manual',projects:[project]}));
 const input=path.join(directory,'input');fs.mkdirSync(input);const data={'manifest.json':JSON.stringify({version}),'LICENSE':'MIT'};
 const files=Object.entries(data).map(([name,bytes])=>{fs.writeFileSync(path.join(input,name),bytes,{mode:0o644});return {path:name,size:Buffer.byteLength(bytes),mode:0o644,sha256:sha(bytes)};});
 const declaration={id,version,arch,launcherArchitectures:arch==='arm64'?['arm64']:['arm64','x64'],minimumMacOS:'13.0',directoryRelative:id+'/'+version+'/'+arch,manifestRelative:'manifest.json',manifestSha256:files[0].sha256,sourceSha256:files[0].sha256,sourceRelative:'manifest.json',files,redistribution:'bundle'};
 const bundle=path.join(directory,'bundle');await prepareRelease({project:id,input,declaration,output:bundle,directory});const {record}=await verifyRelease({bundle,directory});
 return {directory,bundle,record};
}
function releaseTransport(f,{refExists=true}={}){
 const calls=[],remote={id:17,tag_name:f.record.id+'/v'+f.record.version+'/'+f.record.arch,draft:true,assets:[]};
 const asset={id:18,name:f.record.asset.filename,size:f.record.asset.bytes,digest:'sha256:'+f.record.asset.sha256,state:'uploaded'};
 const runGh=async args=>{
  calls.push(args);const endpoint=args.find(arg=>arg.startsWith('repos/')||arg.startsWith('https://uploads.'));
  if(endpoint.includes('/git/ref/')){if(!refExists)throw Object.assign(Error('Not Found'),{stderr:'HTTP 404'});return JSON.stringify({object:{type:'commit',sha:source}});}
  assert.ok(!endpoint.endsWith('/git/refs'),'publisher must never POST git/refs');
  if(args.includes('--paginate'))return '[]'; // The list never observes the just-created draft.
  if(endpoint.includes('/releases/tags/'))throw Object.assign(Error('Not Found'),{stderr:'HTTP 404'});
  if(endpoint.endsWith('/releases')){assert.ok(args.includes('target_commitish='+source));return JSON.stringify(remote);}
  if(endpoint.includes('/releases/17/assets?'))return JSON.stringify(asset);
  if(endpoint.endsWith('/releases/17')&&args.includes('PATCH'))return JSON.stringify({...remote,draft:false});
  assert.fail(args.join(' '));
 };
 return {calls,runGh};
}
test('regression: Existing release identity is incomplete; no tag or asset will be replaced.',async t=>{
 const f=await fixture(t),transport=releaseTransport(f);
 const publication=await stageRelease({...f,target:source,runGh:transport.runGh});
 const result=await publishRelease({...f,publication,runGh:transport.runGh});assert.equal(result.draft,false);assert.equal(result.id,17);
 const create=transport.calls.findIndex(args=>args.includes('POST'));
 assert.ok(transport.calls.slice(create+1).every(args=>!args.includes('--paginate')));
});
test('regression: publisher never POSTs git/refs for an unpublished target',async t=>{
 const f=await fixture(t),transport=releaseTransport(f,{refExists:false});
 const publication=await stageRelease({...f,target:source,runGh:transport.runGh});assert.equal(publication.id,17);
 assert.ok(transport.calls.every(args=>!args.includes('repos/'+repository+'/git/refs')));
});
test('regression: Build job did not succeed: build (innoextract 1.10-dev-MCLv3 x64)',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'publication-job-copy-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository,updatePolicy:'manual',projects:[{id:'innoextract',name:'Inno',delivery:'downloadable',producer:{kind:'prebuilt',version:'1.10-dev-MCLv3',architectures:['x64']},upstreams:[]}]}));
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:repository,GITHUB_WORKFLOW:'Build and release',GITHUB_WORKFLOW_REF:repository+'/.github/workflows/runtime-build.yml@refs/heads/main',GITHUB_SHA:source,GITHUB_RUN_ID:'123',RELEASE_SELECTION:'innoextract=1.10-dev-MCLv3'};
 const result=await publishLevel({verify:async()=>{},directory,env,targets:[{project:'innoextract',version:'1.10-dev-MCLv3',arch:'x64'}],output:path.join(directory,'publication'),runGh:async()=>JSON.stringify([{artifacts:[{id:1,name:'runtime-innoextract-1.10-dev-MCLv3-x64'}]}]),download:async()=>{},publish:async()=>({commit:source})});
 assert.equal(result.failed,0,result.errors[0]?.error);assert.equal(result.published,1);
});
test("regression: ! [remote rejected] HEAD -> main (cannot lock ref 'refs/heads/main': is at 15acfcd but expected 48eaae2)",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'publication-ref-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const remote=path.join(root,'remote.git'),directory=path.join(root,'checkout');git(root,['init','--bare','--initial-branch=main',remote]);git(root,['clone','--quiet',remote,directory]);
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository,updatePolicy:'manual',projects:[{id:'engine',name:'Engine',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/'+repository,entries:['tools/build.mjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:'Engine'}],build:{version:'1.0.0',architectures:['arm64'],command:'tools/build.mjs'}}]}));
 fs.mkdirSync(path.join(directory,'tools'));fs.writeFileSync(path.join(directory,'tools/build.mjs'),'export {};');git(directory,['add','.']);git(directory,['commit','-m','Source']);git(directory,['push','origin','main']);
 const ledger=path.join(root,'ledger.json');fs.writeFileSync(ledger,'fixture ledger');let pushes=0,applied=0;
 const result=await appendPackageCatalog({directory,bundle:root,ledger,record:{id:'engine',version:'1.0.0',arch:'arm64',asset:{sha256:'b'.repeat(64)}},runGh:async()=>{},apply:async({directory})=>{applied++;fs.mkdirSync(path.join(directory,'catalogs'),{recursive:true});fs.writeFileSync(path.join(directory,'catalogs/engine.json'),'own catalog entry');},runGit:async(args,{cwd})=>{if(args[0]==='push'&&pushes++===0)throw Object.assign(Error("! [remote rejected] HEAD -> main (cannot lock ref 'refs/heads/main': is at 15acfcd but expected 48eaae2)"),{stderr:"! [remote rejected] HEAD -> main (cannot lock ref 'refs/heads/main': is at 15acfcd but expected 48eaae2)"});assert.ok(!args.includes('--force'));return git(cwd,args);}});
 assert.equal(result.attempts,2);assert.equal(applied,2);
});
