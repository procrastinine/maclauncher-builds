import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {releaseComponents,orderReleaseComponents,planReleaseDispatch,dispatchReleaseComponents,main} from '../tools/dispatch-release.mjs';
import {planBuildRelease} from '../tools/plan-build-release.mjs';
const hosted=JSON.parse(fs.readFileSync(new URL('./fixtures/release-components/graph.json',import.meta.url)));
const strings=components=>components.map(rows=>rows.map(({id,version})=>id+'='+version));
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'release-dispatch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const write=(name,value)=>{fs.mkdirSync(path.dirname(path.join(directory,name)),{recursive:true});fs.writeFileSync(path.join(directory,name),typeof value==='string'?value:JSON.stringify(value));};
 const project=id=>({id,name:id,delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['tools/'+id+'.mjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:id}],build:{version:'1.0.0',architectures:['arm64','x64'],command:'tools/'+id+'.mjs'}});
 write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:['input','left','right','solo'].map(project)});
 write('releases.txt','input=1.0.0\nleft=1.0.0\nright=1.0.0\nsolo=1.0.0\n');
 for(const id of ['input','solo'])write('tools/'+id+'.mjs','export const source=true;');
 for(const id of ['left','right'])write('tools/'+id+'.mjs',"export function build(){return preparedBuildInput('input');}");
 return directory;
}
test('synthetic selection splits independent packages, shared inputs, chains and ABI pairs exactly',async()=>{
 assert.equal(hosted.selection.length,11);
 const components=releaseComponents(hosted);assert.equal(components.length,5);
 assert.deepEqual(strings(components),hosted.components);
 assert.deepEqual(hosted.components[1],['chain-input=1.0.0','chain-middle=1.0.0','chain-top=1.0.0']);
 assert.equal(hosted.components.filter(rows=>rows.length===1).length,1);
 const calls=[],plan={...hosted,repository:hosted.source.repository,workflow:'runtime-build.yml',ref:'main',components:components.map(selection=>({selection}))};
 await dispatchReleaseComponents(plan,{runGh:args=>calls.push(args)});
 assert.equal(calls.length,5);assert.equal(new Set(calls.flatMap(args=>args.at(-1).slice('releases='.length).split(','))).size,11);
 assert.ok(calls.every(args=>args[2]==='runtime-build.yml'&&args[4]==='owner/builds'&&args[6]==='main'));
});
test('component order follows selection order and is stable across graph key and edge iteration order',()=>{
 const reversed=Object.fromEntries(Object.entries(hosted.graph).reverse().map(([id,inputs])=>[id,[...inputs].reverse()]));
 assert.deepEqual(releaseComponents({...hosted,graph:reversed}),releaseComponents(hosted));
 assert.ok(releaseComponents(hosted).some(rows=>rows.filter(row=>row.id==='abi').length===2));
 assert.ok(releaseComponents(hosted).some(rows=>rows.filter(row=>row.id==='other-abi').length===2));
});
test('shared unpublished inputs build at their releases.txt versions, connect roots before dispatch and preview never writes registrations',async t=>{
 const directory=fixture(t),file=path.join(directory,'projects.json'),before=fs.readFileSync(file,'utf8');
 const plan=await planReleaseDispatch({selection:'left=2.0.0,right=3.0.0,solo=4.0.0',directory});
 assert.deepEqual(plan.components.map(row=>row.releases),['input=1.0.0,left=2.0.0,right=3.0.0','solo=4.0.0']);
 assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('one connected selection produces one ordinary dispatch with the exact same release pairs',async t=>{
 const directory=fixture(t),releases='input=1.0.0,left=2.0.0,right=3.0.0',plan=await planReleaseDispatch({selection:releases,directory});
 const calls=[];await dispatchReleaseComponents(plan,{runGh:args=>calls.push(args)});
 assert.deepEqual(calls,[['workflow','run','runtime-build.yml','--repo','owner/builds','--ref','main','--raw-field','releases='+releases]]);
 const built=await planBuildRelease({selection:releases,directory}),outputs=built.levels.flatMap(level=>level.include);
 assert.deepEqual(built.levels.map(level=>level.index),[0,1]);
 assert.equal(outputs.length,6);for(const id of ['input','left','right'])assert.deepEqual(outputs.filter(row=>row.project===id).map(row=>row.arch).sort(),['arm64','x64']);
});
test('duplicate pairs, overlapping component plans and conflicting ABI revisions reject before any dispatch',async t=>{
 const directory=fixture(t),calls=[],plan=await planReleaseDispatch({selection:'left=2.0.0,solo=4.0.0',directory});
 await assert.rejects(planReleaseDispatch({selection:'left=2.0.0,left=2.0.0',directory}),/Duplicate/);
 await assert.rejects(planReleaseDispatch({selection:'left=2.0.0',directory,releases:[{tag_name:'left/v2.0.0/arm64',draft:false}]}),/already published/);
 await assert.rejects(planReleaseDispatch({selection:'left=1.0.0-MCLv1,left=1.0.0-MCLv2',directory}),/one new version for an ABI line/);
 assert.throws(()=>releaseComponents({selection:[{id:'left',version:2}],graph:{left:[]}}),/project=version/);
 const bad={...plan,components:[plan.components[0],plan.components[0]]};
 await assert.rejects(dispatchReleaseComponents(bad,{runGh:args=>calls.push(args)}),/Duplicate/);
 assert.equal(calls.length,0);
});
test('published read-only inputs do not connect consumers in separate components',()=>{
 const selection=[{id:'left',version:'1.0.0'},{id:'right',version:'1.0.0'}];
 assert.deepEqual(releaseComponents({selection,graph:{left:['published-input'],right:['published-input'],'published-input':[]}}),selection.map(row=>[row]));
});

test('dispatch prioritizes graphics, Android and mpv while preserving the other components',()=>{
 const components=['small','mpv','android','reshade','other'].map(id=>[{id,version:'1.0.0'}]);
 assert.deepEqual(orderReleaseComponents({components}).map(rows=>rows[0].id),['reshade','android','mpv','small','other']);
});

test('dispatch retries only connection establishment failures with bounded backoff',async()=>{
 const selection=[{id:'engine',version:'1.0.0'}],plan={repository:'owner/builds',workflow:'runtime-build.yml',ref:'main',selection,graph:{engine:[]},components:[{selection}]},delays=[];let attempts=0;
 const runGh=()=>{attempts++;if(attempts<5)throw Error(['TLS handshake timeout','connection refused','connection reset','no such host'][attempts-1]);};
 await dispatchReleaseComponents(plan,{runGh,wait:async ms=>delays.push(ms)});assert.equal(attempts,5);assert.deepEqual(delays,[5000,10000,20000,40000]);
 attempts=0;await assert.rejects(dispatchReleaseComponents(plan,{runGh:()=>{attempts++;throw Error('HTTP 403');},wait:()=>assert.fail('No retry after an API response')}),/403/);assert.equal(attempts,1);
});

test('a changed release line already public is skipped without a dispatch',async t=>{
 const directory=fixture(t),calls=[];
 const result=await main(['dispatch','--releases','left=2.0.0'],{directory,runGh:async args=>{calls.push(args);return JSON.stringify([[{tag_name:'left/v2.0.0/arm64',draft:false}]]);}});
 assert.deepEqual(result.dispatched,[]);assert.deepEqual(result.skipped,[{id:'left',version:'2.0.0'}]);assert.equal(calls.length,1);assert.equal(calls[0][0],'api');
});
