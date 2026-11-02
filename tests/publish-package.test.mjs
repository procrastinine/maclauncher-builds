import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {publishPackage,resumePackage,appendPackageCatalog} from '../tools/publish-package.mjs';
const identity={GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
const git=(cwd,args)=>execFileSync('git',args,{cwd,env:{...process.env,...identity},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'package-publish-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const project={id:'engine',name:'Engine',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['build.mjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:'Engine'}],build:{version:'1.0.0',command:'build.mjs',architectures:['arm64']}};
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
  publishBundle:async()=>calls.push('release'),runGh:async args=>{assert.deepEqual(args,['auth','setup-git']);calls.push('credentials');},
  append:async()=>{calls.push('catalog');return {commit:'c'.repeat(40)};}});
 assert.deepEqual(calls,['seal','attest','authority','stage','release','credentials','catalog']);assert.equal(result.project,'engine');
});
test('a failed release cannot create a catalog entry and a different source cannot be published',async t=>{
 const f=fixture(t),options={...f,bundle:f.directory,verifyBundle:async()=>({record:f.record,declaration:{files:[]}}),recordBuild:async()=>{},requireBuild:()=>{},stageBundle:async()=>{throw Error('release failed');},append:()=>assert.fail('No catalog before a public release')};
 await assert.rejects(publishPackage(options),/release failed/);
 await assert.rejects(publishPackage({...options,env:{...f.env,GITHUB_SHA:'c'.repeat(40)}}),/differs from this build job/);
});
test('a published package resumes its same-run bundle before another compile',async t=>{
 const f=fixture(t),calls=[];
 const result=await resumePackage({...f,bundle:path.join(f.directory,'release'),runGh:async args=>{calls.push(args);return '{}';},publish:async()=>({commit:'c'.repeat(40)})});
 assert.equal(result.resumed,true);assert.equal(calls[0][0],'api');assert.deepEqual(calls[1].slice(0,3),['run','download','123']);
 const error=Object.assign(Error('HTTP 404'),{stderr:'HTTP 404'});
 assert.deepEqual(await resumePackage({...f,bundle:f.directory,runGh:async()=>{throw error;},publish:()=>assert.fail()}),{resumed:false});
});
function catalogFixture(t){
 const f=fixture(t),remote=path.join(f.directory,'remote.git'),source=path.join(f.directory,'source'),other=path.join(f.directory,'other');
 git(f.directory,['init','--bare','--initial-branch=main',remote]);git(f.directory,['clone','--quiet',remote,source]);
 fs.copyFileSync(path.join(f.directory,'projects.json'),path.join(source,'projects.json'));fs.writeFileSync(path.join(source,'build.mjs'),'export const build=true;');
 git(source,['add','.']);git(source,['commit','-m','Source']);git(source,['push','origin','main']);git(f.directory,['clone','--quiet',remote,other]);
 const ledger=path.join(f.directory,'ledger.json');fs.writeFileSync(ledger,'verified fixture');
 const apply=async({directory})=>{const file=path.join(directory,'catalogs','engine.json');fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!=='exact entry\n')throw Error('Immutable entry conflict');fs.writeFileSync(file,'exact entry\n');};
 return {...f,directory:source,other,ledger,apply,bundle:f.directory};
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
