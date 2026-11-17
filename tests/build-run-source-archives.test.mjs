import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planBuildRelease} from '../tools/plan-build-release.mjs';
import {prepareBuildInputs} from '../tools/build-run-inputs.mjs';

function fixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'planned-source-archives-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.mkdirSync(path.join(directory,'tools'));fs.mkdirSync(path.join(directory,'producers'));
 const archives=['shared','arm','intel'].map((name,index)=>({url:'https://example.org/'+name+'.tar.gz',sha256:String(index+1).repeat(64)}));
 fs.writeFileSync(path.join(directory,'producers/archives.json'),JSON.stringify(archives));
 fs.writeFileSync(path.join(directory,'tools/fixture.mjs'),'export const fixture=true;\n');
 const project={id:'source-fixture',name:'Source fixture',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/example/builds',entries:['tools/fixture.mjs','producers/archives.json']},upstreams:[],packageProfiles:[{version:'1.0.0',label:'Source fixture'}],build:{version:'1.0.0',architectures:['arm64','x64'],command:'tools/fixture.mjs',archives:archives.map((_,index)=>({file:'producers/archives.json',pointer:'/'+index,...(index?{arch:index===1?'arm64':'x64'}:{})}))}};
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'example/builds',updatePolicy:'manual',projects:[project]}));
 return {directory,archives};
}

test('input preparation fetches planner-reported recipe archives before compile and preserves architecture filtering',async t=>{
 const {directory}=fixture(t),plan=await planBuildRelease({selection:'source-fixture=1.0.0',directory,publish:false});
 const declared=plan.reports['source-fixture'].definition.recipe.archives;
 assert.equal(declared.length,3);assert.ok(declared.some(row=>row.arch==='x64'));
 const fetched=[];
 await prepareBuildInputs({project:'source-fixture',output:path.join(directory,'prepared'),directory,
  environment:{RELEASE_GRAPH:JSON.stringify(plan.graph),BUILD_REPORTS:JSON.stringify(plan.reports),RELEASE_SELECTION:JSON.stringify(plan.selection),BUILD_ARCH:'arm64'},
  fetchArchive:async archive=>{fetched.push(archive);},runGh:async()=>{throw Error('Unexpected remote operation');}});
 assert.deepEqual(fetched,declared.filter(row=>!row.arch||row.arch==='arm64'));
 assert.equal(fetched.length,2);
});

test('legacy flat archive reports remain supported and an empty canonical recipe archive list is authoritative',async t=>{
 const {directory,archives}=fixture(t);
 for(const [name,definition,wanted] of [['legacy',{archives},archives],['canonical-empty',{recipe:{archives:[]},archives},[]]]){
  const fetched=[];await prepareBuildInputs({project:'source-fixture',output:path.join(directory,name),directory,
   environment:{RELEASE_SELECTION:'source-fixture=1.0.0',BUILD_REPORTS:JSON.stringify({'source-fixture':{definition}})},fetchArchive:async archive=>{fetched.push(archive);}});
  assert.deepEqual(fetched,wanted);
 }
});
