import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {publishPackage as actualPublishPackage,appendPackageCatalog} from '../tools/publish-package.mjs';
import {publishLevel} from '../tools/publish-level.mjs';
// Other tests isolate GitHub transport; the focused test below exercises the exact verification call.
const publishPackage=options=>actualPublishPackage({...options,runGh:async(...args)=>args[0][0]==='attestation'?'':options.runGh?.(...args)});
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

  stageBundle:async options=>{assert.equal(options.target,f.env.GITHUB_SHA);calls.push('stage');},
  publishBundle:async()=>calls.push('release'),runGh:async args=>{if(args[0]==='api')throw Object.assign(Error('HTTP 404'),{stderr:'HTTP 404'});assert.deepEqual(args,['auth','setup-git']);calls.push('credentials');},
  append:async()=>{calls.push('catalog');return {commit:'c'.repeat(40)};}});
 assert.deepEqual(calls,['seal','stage','release','catalog']);assert.equal(result.project,'engine');
});
test('a failed release cannot create a catalog entry and a different source cannot be published',async t=>{
 const f=fixture(t),options={...f,bundle:f.directory,verifyBundle:async()=>({record:f.record,declaration:{files:[]}}),runGh:async()=>{throw Object.assign(Error('HTTP 404'),{stderr:'HTTP 404'});},stageBundle:async()=>{throw Error('release failed');},append:()=>assert.fail('No catalog before a public release')};
 await assert.rejects(publishPackage(options),/release failed/);
 await assert.rejects(publishPackage({...options,env:{...f.env,GITHUB_SHA:'c'.repeat(40)}}),/differs from this build job/);
});
test('package publication carries the staged REST identity through release and catalog',async t=>{
 const f=fixture(t),staged={id:17},publicRelease={id:17,draft:false};
 await publishPackage({...f,bundle:f.directory,verifyBundle:async()=>({record:f.record,declaration:{files:[]}}),stageBundle:async()=>staged,publishBundle:async options=>{assert.equal(options.publication,staged);return publicRelease;},append:async options=>{assert.equal(options.publication,publicRelease);return {commit:'c'.repeat(40)};}});
});
test('a level lists artifacts once, publishes the newest attempt and skips absent packages',async t=>{
 const f=fixture(t),published=[],downloads=[],selection=[{id:'engine',version:'1.0.0'},{id:'failed',version:'1.0.0'}];let lists=0;
 const artifacts=[{id:1,name:'runtime-engine-1.0.0-arm64-1'},{id:2,name:'runtime-engine-1.0.0-arm64-2'}];
 const result=await publishLevel({...f,output:path.join(f.directory,'publication'),targets:selection.map(row=>({project:row.id,version:row.version,arch:'arm64'})),env:{...f.env,RELEASE_SELECTION:JSON.stringify(selection)},runGh:async args=>{lists++;assert.equal(args[0],'api');assert.ok(args.at(-1).endsWith('/runs/123/artifacts?per_page=100'));return JSON.stringify([{artifacts}]);},download:async({artifact})=>downloads.push(artifact.id),publish:async options=>{published.push(options.env.BUILD_PROJECT);return {commit:'c'.repeat(40)};}});
 assert.equal(lists,1);assert.deepEqual(downloads,[2]);assert.deepEqual(published,['engine']);assert.equal(result.failed,0);assert.equal(result.skipped,1);;
});
function catalogFixture(t){
 const f=fixture(t),remote=path.join(f.directory,'remote.git'),source=path.join(f.directory,'source'),other=path.join(f.directory,'other');
 git(f.directory,['init','--bare','--initial-branch=main',remote]);git(f.directory,['clone','--quiet',remote,source]);
 fs.copyFileSync(path.join(f.directory,'projects.json'),path.join(source,'projects.json'));fs.mkdirSync(path.join(source,'tools'));fs.writeFileSync(path.join(source,'tools/build.mjs'),'export const build=true;');
 git(source,['add','.']);git(source,['commit','-m','Source']);git(source,['push','origin','main']);git(f.directory,['clone','--quiet',remote,other]);
 const ledger=path.join(f.directory,'ledger.json');fs.writeFileSync(ledger,'verified fixture');
 const entry=JSON.stringify({packages:[f.record]})+'\n';
 const apply=async({directory})=>{const file=path.join(directory,'catalogs','engine.json');fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!==entry)throw Error('Immutable entry conflict');fs.writeFileSync(file,entry);};
 return {...f,directory:source,other,ledger,apply,entry,bundle:f.directory,runGh:async args=>assert.deepEqual(args,['auth','setup-git'])};
}
test('catalog races reapply the own entry onto fresh main and identical appends are no-ops',async t=>{
 const f=catalogFixture(t);let raced=false;
 const runGit=async(args,{cwd})=>{
  if(args[0]==='push'&&!raced){raced=true;fs.writeFileSync(path.join(f.other,'other.txt'),'another package');git(f.other,['add','.']);git(f.other,['commit','-m','Other package']);git(f.other,['push','origin','HEAD:main']);}
  assert.ok(!args.includes('--force'));return git(cwd,args);
 };
 const first=await appendPackageCatalog({...f,runGit});
 assert.equal(first.attempts,2);
 git(f.other,['pull','--ff-only']);assert.equal(fs.readFileSync(path.join(f.other,'other.txt'),'utf8'),'another package');assert.equal(fs.readFileSync(path.join(f.other,'catalogs/engine.json'),'utf8'),f.entry);
 const second=await appendPackageCatalog({...f,runGit});
 assert.equal(second.existing,true);assert.equal(second.commit,first.commit);
});
test('catalog push retries are bounded and non-race failures propagate',async t=>{
 const f=catalogFixture(t);let pushes=0;
 const runGit=async(args,{cwd})=>{if(args[0]==='push'){pushes++;throw Object.assign(Error('rejected'),{stderr:'[rejected] non-fast-forward'});}return git(cwd,args);};
 await assert.rejects(appendPackageCatalog({...f,runGit,attempts:2}),/exhausted 2/);assert.equal(pushes,2);
 await assert.rejects(appendPackageCatalog({...f,runGit:async(args,options)=>{if(args[0]==='push')throw Error('permission denied');return git(options.cwd,args);}}),/permission denied/);
});

test('level publication verifies retained artifacts without consulting rerun job records',async t=>{
 const f=fixture(t),downloads=[],order=[];let active=0;
 const metadata={databaseId:123,workflowName:'Build and release',headSha:f.env.GITHUB_SHA,headBranch:'main',status:'in_progress',conclusion:null};
 const env={...f.env,RELEASE_SELECTION:JSON.stringify([{id:'engine',version:'1.0.0'}])};
 const targets=['arm64','x64'].map(arch=>({project:'engine',version:'1.0.0',arch}));
 const result=await publishLevel({...f,env,output:path.join(f.directory,'publication'),targets,runGh:async()=>JSON.stringify([{artifacts:targets.map((t,i)=>({id:i+1,name:'runtime-engine-1.0.0-'+t.arch}))}]),download:async options=>downloads.push(options.artifact),publish:async options=>{assert.equal(active++,0);order.push(options.env.BUILD_ARCH);await Promise.resolve();active--;return {commit:'c'.repeat(40)};}});
 assert.equal(result.published,2);assert.equal(result.failed,0);assert.equal(downloads.length,2);assert.deepEqual(order,['arm64','x64']);
});

test('the current publisher uses exactly the environment supplied by the original workflow',async t=>{
 const f=fixture(t),reports=path.join(f.directory,'reports.json'),definition='d'.repeat(64),downloaded=[];
 fs.writeFileSync(reports,JSON.stringify({engine:{definitionDigest:definition}}));
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'owner/builds',GITHUB_WORKFLOW:'Build and release',GITHUB_WORKFLOW_REF:'owner/builds/.github/workflows/runtime-build.yml@refs/heads/main',GITHUB_SHA:f.record.build.sourceRevision,GITHUB_RUN_ID:f.record.build.runId,
  RELEASE_SELECTION:JSON.stringify([{id:'engine',version:'1.0.0'}]),RELEASE_GRAPH:JSON.stringify({engine:[]}),RELEASE_REUSE:'[]',PUBLICATION_TARGETS:JSON.stringify({include:[{project:'engine',version:'1.0.0',arch:'arm64'}]}),BUILD_REPORTS:reports};
 const result=await publishLevel({directory:f.directory,env,output:path.join(f.directory,'publication'),runGh:async()=>JSON.stringify([{artifacts:[{id:1,name:'runtime-engine-1.0.0-arm64'}]}]),download:async options=>downloaded.push(options),publish:options=>publishPackage({...options,
  verifyBundle:async()=>({record:f.record,definitionDigest:definition,declaration:{files:[]}}),
  stageBundle:async options=>{assert.equal(options.target,env.GITHUB_SHA);return {id:17};},publishBundle:async()=>({id:17,draft:false}),append:async()=>({commit:'c'.repeat(40)})})});
 assert.equal(result.failed,0,result.errors[0]?.error);assert.equal(result.published,1);assert.equal(downloaded[0].artifact.name,'runtime-engine-1.0.0-arm64');
});

test('artifact transport errors remain publication failures',async t=>{
 const f=fixture(t),target={project:'engine',version:'1.0.0',arch:'arm64'};
 const result=await publishLevel({...f,env:{...f.env,RELEASE_SELECTION:'engine=1.0.0'},targets:[target],output:path.join(f.directory,'publication'),runGh:async()=>JSON.stringify([{artifacts:[{id:1,name:'runtime-engine-1.0.0-arm64'}]}]),download:async()=>{throw Error('HTTP 403: Resource not accessible by integration');},publish:()=>assert.fail('No publication after a transport failure')});
 assert.equal(result.failed,1);assert.equal(result.skipped,0);assert.match(result.errors[0].error,/HTTP 403/);
});

test('the user attestation command retries with bounded backoff and preserves gh failures',async t=>{
 const f=fixture(t),calls=[],delays=[];let staged=0;
 const options={...f,bundle:f.directory,verifyBundle:async()=>({record:f.record,declaration:{files:[]}}),stageBundle:async()=>{staged++;return {id:1};},publishBundle:async()=>({id:1,draft:false}),append:async()=>({commit:'c'.repeat(40)}),wait:async ms=>delays.push(ms)};
 await actualPublishPackage({...options,runGh:async args=>{calls.push(args);if(calls.length<3)throw Error('HTTP 503: gh temporary failure');}});
 assert.deepEqual(calls[0],['attestation','verify',path.join(f.directory,f.record.asset.filename),'--repo','owner/builds','--signer-workflow','owner/builds/.github/workflows/runtime-build.yml']);assert.equal(staged,1);assert.deepEqual(delays,[5000,10000]);
 calls.length=0;delays.length=0;staged=0;await assert.rejects(actualPublishPackage({...options,runGh:async args=>{calls.push(args);throw Error('gh: signature rejected');}}),/^Error: gh: signature rejected$/);assert.equal(staged,0);assert.equal(calls.length,1);assert.deepEqual(delays,[]);
});
