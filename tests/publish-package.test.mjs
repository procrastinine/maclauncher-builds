import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {publishPackage,appendPackageCatalog} from '../tools/publish-package.mjs';
import {publishLevel} from '../tools/publish-level.mjs';
const identity={GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
const git=(cwd,args)=>execFileSync('git',args,{cwd,env:{...process.env,...identity},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'package-publish-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const project={id:'engine',name:'Engine',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['tools/build.mjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:'Engine'}],build:{version:'1.0.0',command:'tools/build.mjs',architectures:['arm64']}};
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[project]}));
 const env={...identity,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'owner/builds',GITHUB_RUN_ID:'123',GITHUB_SHA:'a'.repeat(40),GITHUB_WORKFLOW:'Build and release',GITHUB_WORKFLOW_REF:'owner/builds/.github/workflows/runtime-build.yml@refs/heads/main',BUILD_PROJECT:'engine',BUILD_VERSION:'1.0.0',BUILD_ARCH:'arm64'};
 const record={id:'engine',version:'1.0.0',arch:'arm64',asset:{filename:'engine.tar.gz',sha256:'b'.repeat(64)},build:{sourceRevision:env.GITHUB_SHA,runId:'123'}};
 return {directory,env,record};
}
test('a package publishes after its attestation and before its catalog entry, without waiting for other jobs',async t=>{
 const f=fixture(t),calls=[];
 const result=await publishPackage({...f,bundle:f.directory,
  verifyBundle:async()=>{calls.push('seal');return {record:f.record,declaration:{files:[]}};},
  recordBuild:async()=>calls.push('attest'),requireBuild:()=>calls.push('authority'),
  stageBundle:async options=>{assert.equal(options.target,f.env.GITHUB_SHA);calls.push('stage');},
  publishBundle:async()=>calls.push('release'),runGh:async args=>{if(args[0]==='api')throw Object.assign(Error('HTTP 404'),{stderr:'HTTP 404'});assert.deepEqual(args,['auth','setup-git']);calls.push('credentials');},
  append:async()=>{calls.push('catalog');return {commit:'c'.repeat(40)};}});
 assert.deepEqual(calls,['seal','attest','authority','stage','release','catalog']);assert.equal(result.project,'engine');
});
test('a failed release cannot create a catalog entry and a different source cannot be published',async t=>{
 const f=fixture(t),options={...f,bundle:f.directory,verifyBundle:async()=>({record:f.record,declaration:{files:[]}}),recordBuild:async()=>{},requireBuild:()=>{},runGh:async()=>{throw Object.assign(Error('HTTP 404'),{stderr:'HTTP 404'});},stageBundle:async()=>{throw Error('release failed');},append:()=>assert.fail('No catalog before a public release')};
 await assert.rejects(publishPackage(options),/release failed/);
 await assert.rejects(publishPackage({...options,env:{...f.env,GITHUB_SHA:'c'.repeat(40)}}),/differs from this build job/);
});
test('only the same run can resume an existing release',async t=>{
 const f=fixture(t),options={...f,bundle:f.directory,verifyBundle:async()=>({record:f.record,declaration:{files:[]}}),recordBuild:async()=>{},requireBuild:()=>{},stageBundle:async()=>{},publishBundle:async()=>{},append:async()=>({commit:'c'.repeat(40)})};
 const same=await publishPackage({...options,runGh:async args=>args[0]==='api'?JSON.stringify({body:'Built by https://github.com/owner/builds/actions/runs/123'}):''});assert.equal(same.project,'engine');
 await assert.rejects(publishPackage({...options,runGh:async()=>JSON.stringify({body:'Built by https://github.com/owner/builds/actions/runs/99'})}),/already published by run 99/);
});
test('a clean level publisher releases passed jobs without waiting for another build level',async t=>{
 const f=fixture(t),published=[],downloads=[],selection=[{id:'engine',version:'1.0.0'},{id:'failed',version:'1.0.0'}];
 const metadata={databaseId:123,workflowName:'Build and release',headSha:f.env.GITHUB_SHA,headBranch:'main',status:'in_progress',conclusion:null,jobs:[{name:'build (engine 1.0.0 arm64)',status:'completed',conclusion:'success'},{name:'build (failed 1.0.0 arm64)',status:'completed',conclusion:'failure'},{name:'build (later 1.0.0 arm64)',status:'in_progress',conclusion:null}]};
 const result=await publishLevel({...f,output:path.join(f.directory,'publication'),targets:selection.map(row=>({project:row.id,version:row.version,arch:'arm64'})),env:{...f.env,RELEASE_SELECTION:JSON.stringify(selection)},runGh:async args=>{if(args[1]==='view')return JSON.stringify(metadata);downloads.push(args);return '';},publish:async options=>{published.push(options.env.BUILD_PROJECT);return {commit:'c'.repeat(40)};}});
 assert.deepEqual(published,['engine']);assert.equal(downloads.length,1);assert.equal(result.failed,1);assert.match(result.errors[0].error,/Build job did not succeed/);
});
test('unpublished selected inputs block only their consumers before downloading artifacts',async t=>{
 const f=fixture(t),registry=JSON.parse(fs.readFileSync(path.join(f.directory,'projects.json')));registry.projects.push({...structuredClone(registry.projects[0]),id:'input',name:'Input'});fs.writeFileSync(path.join(f.directory,'projects.json'),JSON.stringify(registry));
 const env={...f.env,RELEASE_SELECTION:JSON.stringify([{id:'engine',version:'1.0.0'},{id:'input',version:'1.0.0'}]),RELEASE_GRAPH:JSON.stringify({engine:['input']})};
 const metadata={databaseId:123,workflowName:'Build and release',headSha:env.GITHUB_SHA,headBranch:'main',conclusion:null,jobs:[{name:'build (engine 1.0.0 arm64)',status:'completed',conclusion:'success'}]};
 const result=await publishLevel({...f,env,output:path.join(f.directory,'publication'),targets:[{project:'engine',version:'1.0.0',arch:'arm64'}],runGh:async args=>{if(args[1]==='view')return JSON.stringify(metadata);if(args[0]==='api')throw Object.assign(Error('HTTP 404'),{stderr:'HTTP 404'});assert.fail('Unpublished input must stop before download');},publish:()=>assert.fail('Unpublished input must stop publication')});
 assert.equal(result.published,0);assert.match(result.errors[0].error,/Required input is not published: input/);
});
function catalogFixture(t){
 const f=fixture(t),remote=path.join(f.directory,'remote.git'),source=path.join(f.directory,'source'),other=path.join(f.directory,'other');
 git(f.directory,['init','--bare','--initial-branch=main',remote]);git(f.directory,['clone','--quiet',remote,source]);
 fs.copyFileSync(path.join(f.directory,'projects.json'),path.join(source,'projects.json'));fs.mkdirSync(path.join(source,'tools'));fs.writeFileSync(path.join(source,'tools/build.mjs'),'export const build=true;');
 git(source,['add','.']);git(source,['commit','-m','Source']);git(source,['push','origin','main']);git(f.directory,['clone','--quiet',remote,other]);
 const ledger=path.join(f.directory,'ledger.json');fs.writeFileSync(ledger,'verified fixture');
 const apply=async({directory})=>{const file=path.join(directory,'catalogs','engine.json');fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!=='exact entry\n')throw Error('Immutable entry conflict');fs.writeFileSync(file,'exact entry\n');};
 return {...f,directory:source,other,ledger,apply,bundle:f.directory,runGh:async args=>assert.deepEqual(args,['auth','setup-git'])};
}
test('catalog races reapply the own entry onto fresh main and identical appends are no-ops',async t=>{
 const f=catalogFixture(t);let raced=false,slept=0;
 const runGit=async(args,{cwd})=>{
  if(args[0]==='push'&&!raced){raced=true;fs.writeFileSync(path.join(f.other,'other.txt'),'another package');git(f.other,['add','.']);git(f.other,['commit','-m','Other package']);git(f.other,['push','origin','HEAD:main']);}
  assert.ok(!args.includes('--force'));return git(cwd,args);
 };
 const first=await appendPackageCatalog({...f,runGit,sleep:async()=>slept++,random:()=>0});
 assert.equal(first.attempts,2);assert.equal(slept,1);
 git(f.other,['pull','--ff-only']);assert.equal(fs.readFileSync(path.join(f.other,'other.txt'),'utf8'),'another package');assert.equal(fs.readFileSync(path.join(f.other,'catalogs/engine.json'),'utf8'),'exact entry\n');
 const second=await appendPackageCatalog({...f,runGit,sleep:()=>assert.fail('Identical entry needs no retry')});
 assert.equal(second.existing,true);assert.equal(second.commit,first.commit);
});
test('catalog push retries are bounded and non-race failures propagate',async t=>{
 const f=catalogFixture(t);let pushes=0;
 const runGit=async(args,{cwd})=>{if(args[0]==='push'){pushes++;throw Object.assign(Error('rejected'),{stderr:'[rejected] non-fast-forward'});}return git(cwd,args);};
 await assert.rejects(appendPackageCatalog({...f,runGit,attempts:2,sleep:async()=>{}}),/exhausted 2/);assert.equal(pushes,2);
 await assert.rejects(appendPackageCatalog({...f,runGit:async(args,options)=>{if(args[0]==='push')throw Error('permission denied');return git(options.cwd,args);},sleep:()=>assert.fail()}),/permission denied/);
});

test('level publication waits for rerun job copies, but completed failures never wait',async t=>{
 for(const state of ['delayed','failed','missing']){
  const f=fixture(t),waits=[],downloads=[],published=[];let reads=0;
  const job={name:'build (engine 1.0.0 arm64)',status:'completed',conclusion:'success'};
  const env={...f.env,RELEASE_SELECTION:JSON.stringify([{id:'engine',version:'1.0.0'}])};
  const result=await publishLevel({...f,env,output:path.join(f.directory,'publication'),targets:[{project:'engine',version:'1.0.0',arch:'arm64'}],sleep:async ms=>waits.push(ms),runGh:async args=>{
   if(args[1]==='view'){
    reads++;
    const jobs=state==='failed'?[{...job,conclusion:'failure'}]:state==='missing'||reads===1?[]:reads===2?[{...job,status:'queued',conclusion:null}]:reads===3?[{...job,status:'in_progress',conclusion:null}]:[job];
    return JSON.stringify({databaseId:123,workflowName:'Build and release',headSha:env.GITHUB_SHA,headBranch:'main',status:'in_progress',conclusion:null,jobs});
   }
   downloads.push(args);return '';
  },publish:async options=>{published.push(options.env.BUILD_PROJECT);return {commit:'c'.repeat(40)};}});
  if(state==='delayed'){
   assert.equal(result.published,1);assert.equal(result.failed,0);assert.equal(reads,4);assert.deepEqual(waits,[2000,4000,8000]);assert.deepEqual(published,['engine']);assert.equal(downloads.length,1);
  }else{
   assert.equal(result.published,0);assert.equal(result.failed,1);assert.match(result.errors[0].error,/Build job did not succeed/);assert.equal(downloads.length,0);assert.equal(published.length,0);
   assert.equal(reads,state==='failed'?1:6);assert.deepEqual(waits,state==='failed'?[]:[2000,4000,8000,16000,30000]);
  }
 }
});
