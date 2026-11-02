import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {releaseComponents,planReleaseDispatch,dispatchReleaseComponents} from '../tools/dispatch-release.mjs';
const hosted=JSON.parse(fs.readFileSync(new URL('./fixtures/release-components/run-41506103317.json',import.meta.url)));
const strings=components=>components.map(rows=>rows.map(({id,version})=>id+'='+version));
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'release-dispatch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const write=(name,value)=>{fs.mkdirSync(path.dirname(path.join(directory,name)),{recursive:true});fs.writeFileSync(path.join(directory,name),typeof value==='string'?value:JSON.stringify(value));};
 const project=id=>({id,name:id,delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['tools/'+id+'.mjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:id}],build:{version:'1.0.0',architectures:['arm64'],command:'tools/'+id+'.mjs'}});
 write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:['input','left','right','solo'].map(project)});
 for(const id of ['input','solo'])write('tools/'+id+'.mjs','export const source=true;');
 for(const id of ['left','right'])write('tools/'+id+'.mjs',"export function build(){return preparedBuildInput('input');}");
 return directory;
}
test('hosted 74-pair selection splits into the exact 37 independent components with graphics isolated',async()=>{
 assert.equal(hosted.selection.length,74);
 const components=releaseComponents(hosted);assert.equal(components.length,37);
 assert.deepEqual(strings(components),hosted.components);
 assert.deepEqual(hosted.components.at(-1),['graphics-moltenvk=1.4.2-MCLv1','graphics-data=1.0.0','reshade=0.3.2']);
 assert.equal(hosted.components.filter(rows=>rows.length===1).length,32);
 const calls=[],plan={...hosted,repository:hosted.source.repository,workflow:'runtime-build.yml',ref:'main',components:components.map(selection=>({selection}))};
 await dispatchReleaseComponents(plan,{runGh:args=>calls.push(args)});
 assert.equal(calls.length,37);assert.equal(new Set(calls.flatMap(args=>args.at(-1).slice('releases='.length).split(','))).size,74);
 assert.ok(calls.every(args=>args[2]==='runtime-build.yml'&&args[4]==='procrastinine/maclauncher-builds'&&args[6]==='main'));
});
test('component order follows selection order and is stable across graph key and edge iteration order',()=>{
 const reversed=Object.fromEntries(Object.entries(hosted.graph).reverse().map(([id,inputs])=>[id,[...inputs].reverse()]));
 assert.deepEqual(releaseComponents({...hosted,graph:reversed}),releaseComponents(hosted));
 assert.ok(releaseComponents(hosted).some(rows=>rows.filter(row=>row.id==='hashlink').length===2));
 assert.ok(releaseComponents(hosted).some(rows=>rows.filter(row=>row.id==='java-steamworks').length===2));
});
test('shared automatically rebuilt inputs connect roots before dispatch and preview never writes registrations',async t=>{
 const directory=fixture(t),file=path.join(directory,'projects.json'),before=fs.readFileSync(file,'utf8');
 const plan=await planReleaseDispatch({selection:'left=2.0.0,right=3.0.0,solo=4.0.0',directory});
 assert.deepEqual(plan.components.map(row=>row.releases),['input=1.0.0,left=2.0.0,right=3.0.0','solo=4.0.0']);
 assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('one connected selection produces one ordinary dispatch with the exact same release pairs',async t=>{
 const directory=fixture(t),releases='input=1.0.0,left=2.0.0,right=3.0.0',plan=await planReleaseDispatch({selection:releases,directory});
 const calls=[];await dispatchReleaseComponents(plan,{runGh:args=>calls.push(args)});
 assert.deepEqual(calls,[['workflow','run','runtime-build.yml','--repo','owner/builds','--ref','main','--raw-field','releases='+releases]]);
});
test('duplicate pairs, overlapping component plans and conflicting ABI revisions reject before any dispatch',async t=>{
 const directory=fixture(t),calls=[],plan=await planReleaseDispatch({selection:'left=2.0.0,solo=4.0.0',directory});
 await assert.rejects(planReleaseDispatch({selection:'left=2.0.0,left=2.0.0',directory}),/Duplicate/);
 await assert.rejects(planReleaseDispatch({selection:'left=1.0.0-MCLv1,left=1.0.0-MCLv2',directory}),/one new version for an ABI line/);
 assert.throws(()=>releaseComponents({selection:[{id:'left',version:2}],graph:{left:[]}}),/exact project=version/);
 const bad={...plan,components:[plan.components[0],plan.components[0]]};
 await assert.rejects(dispatchReleaseComponents(bad,{runGh:args=>calls.push(args)}),/Duplicate/);
 assert.equal(calls.length,0);
});
test('published read-only inputs do not connect consumers in separate components',()=>{
 const selection=[{id:'left',version:'1.0.0'},{id:'right',version:'1.0.0'}];
 assert.deepEqual(releaseComponents({selection,graph:{left:['published-input'],right:['published-input'],'published-input':[]}}),selection.map(row=>[row]));
});
