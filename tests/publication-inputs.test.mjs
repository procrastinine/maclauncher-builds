import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {publishPackage} from '../tools/publish-package.mjs';
for(const state of ['missing','draft','different digest','public','this run missing','this run draft'])test('publication checks the sealed input before staging: '+state,async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'publication-input-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[{id:'engine',name:'Engine',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['tools/build.mjs']},build:{version:'1.0.0',architectures:['arm64'],command:'tools/build.mjs'},upstreams:[],packageProfiles:[{version:'1.0.0',label:'Engine'}]}]}));
 fs.mkdirSync(path.join(directory,'tools'));fs.writeFileSync(path.join(directory,'tools/build.mjs'),'export {};');
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'owner/builds',GITHUB_RUN_ID:'123',GITHUB_SHA:'a'.repeat(40),GITHUB_WORKFLOW:'Build and release',GITHUB_WORKFLOW_REF:'owner/builds/.github/workflows/runtime-build.yml@refs/heads/main',BUILD_PROJECT:'engine',BUILD_VERSION:'1.0.0',BUILD_ARCH:'arm64'};
 if(state.startsWith('this run'))env.RELEASE_SELECTION='engine=1.0.0,native=2.0.0';
 const record={id:'engine',version:'1.0.0',arch:'arm64',asset:{filename:'engine-1.0.0-arm64.tar.gz',sha256:'b'.repeat(64)},build:{sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}};
 const input={id:'native',version:'2.0.0',arch:'arm64',release:'native/v2.0.0/arm64',sha256:'c'.repeat(64)};let staged=0,reads=0;
 const operation=()=>publishPackage({bundle:directory,directory,env,verifyBundle:async()=>{return {record,declaration:{files:[{path:'build-inputs.json'}]},metadata:{'build-inputs.json':Buffer.from(JSON.stringify({schemaVersion:1,inputs:[input]}))}};},
  runGh:async args=>{if(args[1]==='repos/owner/builds/releases/tags/engine%2Fv1.0.0%2Farm64')throw Object.assign(Error('HTTP 404'),{stderr:'HTTP 404'});reads++;assert.deepEqual(args,['api','repos/owner/builds/releases/tags/'+encodeURIComponent(input.release)]);if(state.endsWith('missing'))throw Error('HTTP 404');return JSON.stringify({tag_name:input.release,draft:state.endsWith('draft'),assets:[{digest:'sha256:'+(state==='different digest'?'d'.repeat(64):input.sha256)}]});},
  stageBundle:async()=>{staged++;return {id:17};},publishBundle:async()=>({id:17,draft:false}),append:async()=>({commit:'e'.repeat(40)})});
 if(state.startsWith('this run')){const result=await operation();assert.equal(result.skipped,true);assert.match(result.notice,/input native 2.0.0 arm64 from this run is not published; see its publish job/);assert.equal(staged,0);}
 else if(state==='public'){await operation();assert.equal(staged,1);}else{await assert.rejects(operation(),/HTTP 404|Required sealed input/);assert.equal(staged,0);}
 assert.equal(reads,1);
});
