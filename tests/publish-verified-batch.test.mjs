import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {publishCurrentRun} from '../tools/publish-verified.mjs';
import {parseSelection,registerSelection} from '../tools/release-selection.mjs';

const requests=[
 {id:'android-aim',version:'MCLv3-1028-6'},
 {id:'vnds-love',version:'0.0.13-838e47b-MCLv2'},
 {id:'siglus',version:'1.0.0-preview.5f358ef1360b-MCLv2-1028-1'}
];
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'current-release-source-')),output=fs.mkdtempSync(path.join(os.tmpdir(),'current-release-output-'));
 t.after(()=>{fs.rmSync(directory,{recursive:true,force:true});fs.rmSync(output,{recursive:true,force:true});});
 const oldVersions=['MCLv2-1028-6','0.0.13-838e47b-MCLv1','1.0.0-preview.5f358ef1360b-MCLv1-1028-1','1.0.0'];
 const projects=[...requests,{id:'unrelated'}].map(({id},index)=>({id,name:id,delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',sourceRepository:'https://github.com/upstream/'+id,entries:['tools/build.mjs']},upstreams:[],packageProfiles:[{version:oldVersions[index],label:id+' '+oldVersions[index]}],build:{version:oldVersions[index],command:'tools/build.mjs',architectures:['arm64','x64'],tools:['cmake']}}));
 const registry=path.join(directory,'projects.json');fs.writeFileSync(registry,JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects},null,2)+'\n');
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'owner/builds',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),GITHUB_WORKFLOW:'Build and release',GITHUB_WORKFLOW_REF:'owner/builds/.github/workflows/runtime-build.yml@refs/heads/main'},downloads=[],records=new Map(),calls=[];
 let run,active=0,max=0;
 const register=({tags=[],releases=[]}={})=>{
  const registered=registerSelection({selection:JSON.stringify(requests),directory,tags,releases});env.RELEASE_SELECTION=JSON.stringify(registered.selection);
  const jobs=registered.include.map(row=>{calls.push('build:'+row.project+':'+row.version+':'+row.arch);return {name:'build ('+[row.project,row.version,row.arch].join(' ')+')',status:'completed',conclusion:'success'};});
  run={databaseId:123,workflowName:env.GITHUB_WORKFLOW,headSha:env.GITHUB_SHA,headBranch:'main',status:'in_progress',conclusion:null,jobs};return registered;
 };
 const runGh=async args=>{
  if(args[1]==='view'){assert.equal(args[2],env.GITHUB_RUN_ID);return JSON.stringify(run);}
  assert.equal(args[1],'download');assert.equal(args[2],env.GITHUB_RUN_ID);
  const destination=args[args.indexOf('--dir')+1],arch=path.basename(destination),version=path.basename(path.dirname(destination)),project=path.basename(path.dirname(path.dirname(destination)));
  const record={id:project,version,arch,build:{sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,runAttempt:'1'},asset:{filename:project+'.tar.gz',sha256:crypto.createHash('sha256').update(project+version+arch).digest('hex')}};
  downloads.push({project,version,arch});records.set(destination,record);fs.writeFileSync(path.join(destination,record.asset.filename),'sealed');return '';
 };
 const verifyBundle=async({bundle})=>{calls.push('read:'+bundle);return {record:records.get(bundle)};};
 const recordBuild=async({record,archive})=>{assert.ok(fs.existsSync(archive));assert.equal(record.build.runId,env.GITHUB_RUN_ID);assert.equal(record.build.sourceRevision,env.GITHUB_SHA);calls.push('signature:'+record.id+record.arch);fs.mkdirSync(path.join(directory,'attestations'),{recursive:true});fs.writeFileSync(path.join(directory,'attestations',record.asset.sha256+'.json'),'verified fixture');};
 const requireBuild=({record,sourceRevision})=>assert.equal(record.build.sourceRevision,sourceRevision);
 const prepareBundle=async({output,record})=>{fs.mkdirSync(output,{recursive:true});records.set(output,record);};
 const stageBundle=async({bundle,target})=>{assert.equal(target,env.GITHUB_SHA);calls.push('stage:'+records.get(bundle).id+records.get(bundle).arch);active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,3));active--;};
 const publishBundle=async({bundle})=>calls.push('publish:'+records.get(bundle).id+records.get(bundle).arch),applyBundle=async({bundle})=>calls.push('apply:'+records.get(bundle).id+records.get(bundle).arch);
 return{directory,output,env,registry,projects,register,runGh,verifyBundle,recordBuild,requireBuild,prepareBundle,stageBundle,publishBundle,applyBundle,downloads,calls,max:()=>max};
}

test('one request registers exact custom versions and releases every selected CPU without unrelated projects',async t=>{
 const f=fixture(t),registered=f.register(),expected=requests.flatMap(({id,version})=>['arm64','x64'].map(arch=>({project:id,version,arch})));
 assert.deepEqual(registered.selection,requests);assert.deepEqual(parseSelection(f.env.RELEASE_SELECTION),requests);assert.deepEqual(registered.include,expected);
 const after=JSON.parse(fs.readFileSync(f.registry));assert.deepEqual(after.projects.find(row=>row.id==='unrelated'),f.projects.find(row=>row.id==='unrelated'));
 for(const request of requests){const current=after.projects.find(row=>row.id===request.id),previous=f.projects.find(row=>row.id===request.id);assert.equal(current.build.version,request.version);assert.deepEqual(current.build.architectures,['arm64','x64']);assert.deepEqual(current.build.tools,['cmake']);assert.deepEqual(current.producer,previous.producer);assert.ok(current.packageProfiles.some(profile=>profile.version===previous.build.version));assert.ok(current.packageProfiles.some(profile=>profile.version===request.version));}
 const result=await publishCurrentRun(f);assert.equal(result.selected,6);assert.equal(result.published,6);assert.equal(result.failed,0);assert.deepEqual(f.downloads,expected);assert.ok(f.max()>1&&f.max()<=8);assert.equal(f.calls.filter(call=>call.startsWith('apply:')).length,6);
 for(const row of result.results){assert.equal(row.runId,f.env.GITHUB_RUN_ID);assert.ok(f.calls.indexOf('signature:'+row.project+row.arch)<f.calls.indexOf('stage:'+row.project+row.arch));}
 assert.ok(!f.calls.some(call=>call.includes('unrelated')));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output,'publication-result.json'))),result);
});

test('an existing remote release name rejects registration before mutation, build, download or publication',t=>{
 const f=fixture(t),before=fs.readFileSync(f.registry,'utf8'),releases=[{tag_name:'siglus/v'+requests[2].version+'/arm64',draft:false}];
 assert.throws(()=>f.register({releases}),/already published/);assert.equal(fs.readFileSync(f.registry,'utf8'),before);assert.deepEqual(f.downloads,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(fs.readdirSync(f.output),[]);
});
