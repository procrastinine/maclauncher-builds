import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readProjects,resolveProject} from '../lib/projects.mjs';
import {checkProjects} from '../tools/check-updates.mjs';
import {prepareRelease,verifyRelease,catalogIndex,releaseNotes,stageRelease} from '../tools/release-runtime.mjs';

const current='1'.repeat(40),held='2'.repeat(40),next='3'.repeat(40),target='a'.repeat(40);
const pinFile='producers/engine/source.json';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const write=(root,file,value)=>{const destination=path.join(root,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(value,null,2)+'\n');};
const moduleSource=(root,file,text)=>{const destination=path.join(root,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,text);};
const upstream=(id='engine',pointer='/source')=>({id,provider:'github',url:'https://github.com/owner/source',repository:'owner/source',pin:{file:pinFile,pointer}});
const project=(upstreams=[upstream()],id='engine')=>({id,name:id,delivery:'downloadable',producer:{kind:'prebuilt',version:'1.0',architectures:['arm64']},upstreams});
function fixture(t,{projects=[project()],source={source:{repository:'https://github.com/owner/source.git',revision:current,version:'1.0',committedAt:'2026-10-26T04:38:52.000Z'}}}={}){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'source-pin-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const registry={schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects};write(root,'projects.json',registry);if(source!==null)write(root,pinFile,source);
 return {root,registry,save:()=>write(root,'projects.json',registry),source:value=>write(root,pinFile,value)};
}

test('canonical JSON pins supply object and scalar revisions through RFC 6901 pointers',t=>{
 const entries=[upstream('revision','/source'),upstream('commit','/commit-source'),upstream('escaped','/profiles/a~1b~0c/revision'),{...upstream('scalar','/scalar'),pin:{file:pinFile,pointer:'/scalar',repositoryPointer:'/origin'}}];
 const f=fixture(t,{projects:[project(entries)],source:{source:{repository:'https://github.com/owner/source.git',revision:current,version:'1.0',committedAt:'2026-10-26T04:38:52.000Z'},'commit-source':{url:'https://github.com/owner/source',commit:held},profiles:{'a/b~c':{revision:next}},scalar:current,origin:'https://github.com/owner/source.git'}});
 const selected=resolveProject('engine',f.root);assert.deepEqual(selected.upstreams.map(row=>row.revision),[current,held,next,current]);
 assert.equal(selected.upstreams[0].version,'1.0');assert.equal(selected.upstreams[0].committedAt,'2026-10-26T04:38:52.000Z');
 assert.ok(selected.upstreams.every(row=>!Object.hasOwn(row,'pin')));
 f.registry.projects[0].upstreams=[upstream('root','')];f.save();f.source({repository:'https://github.com/owner/source.git',revision:held});
 assert.equal(resolveProject('engine',f.root).upstreams[0].revision,held);
});

test('one canonical file change updates the next resolved read and preserves flat registry round trips',t=>{
 const f=fixture(t),rawBefore=fs.readFileSync(path.join(f.root,'projects.json'));
 const before=readProjects(f.root);assert.equal(before.projects[0].upstreams[0].revision,current);
 f.source({source:{repository:'https://github.com/owner/source',revision:next,version:'1.1',committedAt:'2026-10-27T00:00:00Z'}});
 const after=readProjects(f.root);assert.equal(after.projects[0].upstreams[0].revision,next);assert.equal(after.projects[0].upstreams[0].version,'1.1');assert.equal(after.projects[0].upstreams[0].committedAt,'2026-10-27T00:00:00Z');
 assert.deepEqual(fs.readFileSync(path.join(f.root,'projects.json')),rawBefore);assert.equal(before.projects[0].upstreams[0].revision,current);
 write(f.root,'projects.json',after);fs.unlinkSync(path.join(f.root,pinFile));assert.deepEqual(readProjects(f.root),after);
});

test('matched catalog pins retain the selected version across insertion and reordering and reject ambiguity',t=>{
 const selected={version:'1.16',upstreamRevision:held},previous={version:'1.17',upstreamRevision:current},latest={version:'1.18',upstreamRevision:next};
 const pin={file:pinFile,pointer:'/catalog',match:{version:'1.16'},field:'/upstreamRevision'},f=fixture(t,{projects:[project([{...upstream(),pin}])],source:{catalog:[previous,selected]}});
 assert.equal(resolveProject('engine',f.root).upstreams[0].revision,held);
 f.source({catalog:[selected,previous]});assert.equal(resolveProject('engine',f.root).upstreams[0].revision,held);
 f.source({catalog:[latest,previous,selected]});assert.equal(readProjects(f.root).projects[0].upstreams[0].revision,held);
 f.source({catalog:[latest,previous]});assert.throws(()=>resolveProject('engine',f.root));
 f.source({catalog:[selected,{...selected,upstreamRevision:next}]});assert.throws(()=>readProjects(f.root));assert.throws(()=>resolveProject('engine',f.root));
 assert.deepEqual(readProjects(f.root,{resolvePins:false}),f.registry);
});

test('owned CommonJS exports are authoritative and refresh on the next read without invoking a build',t=>{
 const file='producers/engine/source.cjs',pin={file,pointer:'/REVISION',repositoryPointer:'/source/repository'},f=fixture(t,{projects:[project([{...upstream(),pin},{...upstream('object'),pin:{file,pointer:'/source'}}])],source:null});
 const source=character=>`const revision=${JSON.stringify(character)}.repeat(40); exports.REVISION=revision; exports.source={repository:'https://github.com/owner/source.git',revision}; exports.build=()=>{throw Error('Build must not run while resolving pins');};\n`;
 moduleSource(f.root,file,source('1'));assert.deepEqual(readProjects(f.root).projects[0].upstreams.map(row=>row.revision),[current,current]);
 const registryBefore=fs.readFileSync(path.join(f.root,'projects.json'));moduleSource(f.root,file,source('3'));
 assert.deepEqual(readProjects(f.root).projects[0].upstreams.map(row=>row.revision),[next,next]);assert.equal(resolveProject('engine',f.root).upstreams[0].revision,next);assert.deepEqual(fs.readFileSync(path.join(f.root,'projects.json')),registryBefore);
 write(f.root,'producers/engine/source.json',{revision:current});moduleSource(f.root,file,"exports.REVISION='invalid'; exports.source={repository:'https://github.com/owner/source',revision:'invalid'};\n");
 assert.throws(()=>resolveProject('engine',f.root));
});

test('metadata-only CommonJS references do not execute modules or require their dependencies',t=>{
 const file='producers/engine/source.js',f=fixture(t,{projects:[project([{...upstream(),pin:{file,pointer:'/REVISION'}}])],source:null});
 write(f.root,'producers/engine/package.json',{type:'commonjs'});moduleSource(f.root,file,"throw Error('Metadata pin module was executed');\n");
 assert.deepEqual(readProjects(f.root,{resolvePins:false}),f.registry);assert.deepEqual(resolveProject('engine',f.root,{resolvePins:false}).upstreams,f.registry.projects[0].upstreams);assert.deepEqual(catalogIndex(f.root).projects,[]);
 assert.throws(()=>resolveProject('engine',f.root));
 for(const outside of ['sources/engine/source.cjs','projects/source.js']){
  f.registry.projects[0].upstreams=[{...upstream(),pin:{file:outside,pointer:'/REVISION'}}];f.save();assert.throws(()=>readProjects(f.root,{resolvePins:false}),undefined,outside);
 }
});

test('pin references reject inline identity overrides and unknown reference fields before file access',t=>{
 const f=fixture(t,{source:null});
 for(const extra of [{revision:current},{version:'1.0'},{committedAt:'2026-10-26T04:38:52.000Z'}]){
  f.registry.projects[0].upstreams=[{...upstream(),...extra}];f.save();assert.throws(()=>readProjects(f.root,{resolvePins:false}),undefined,JSON.stringify(extra));
 }
 for(const pin of [{file:pinFile,pointer:'/source',revision:current},{file:pinFile,pointer:'/source',fallback:current},{file:pinFile,pointer:'/source',repositoryPointer:4},{file:pinFile},{pointer:'/source'},null]){
  f.registry.projects[0].upstreams=[{...upstream(),pin}];f.save();assert.throws(()=>readProjects(f.root,{resolvePins:false}),undefined,JSON.stringify(pin));
 }
});

test('unsafe reference paths and malformed pointers fail even in metadata-only mode',t=>{
 const f=fixture(t,{source:null});
 for(const file of ['../source.json','/tmp/source.json','producers/../source.json','producers\\source.json','producers//source.json']){
  f.registry.projects[0].upstreams=[{...upstream(),pin:{file,pointer:'/source'}}];f.save();assert.throws(()=>readProjects(f.root,{resolvePins:false}),undefined,file);
 }
 for(const pointer of ['source','/source/~2','/source/~',7,null]){
  f.registry.projects[0].upstreams=[{...upstream(),pin:{file:pinFile,pointer}}];f.save();assert.throws(()=>readProjects(f.root,{resolvePins:false}),undefined,String(pointer));
 }
});

test('missing, invalid and escaped canonical files never acquire a replacement pin',t=>{
 const f=fixture(t,{source:null});assert.throws(()=>readProjects(f.root));
 f.source({source:{repository:'https://github.com/owner/source.git',revision:'short'}});assert.throws(()=>readProjects(f.root));
 f.source({other:{repository:'https://github.com/owner/source.git',revision:current}});assert.throws(()=>readProjects(f.root));
 fs.writeFileSync(path.join(f.root,pinFile),'not JSON');assert.throws(()=>readProjects(f.root));
 const outside=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'outside-source-pin-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));write(outside,'source.json',{source:{repository:'https://github.com/owner/source',revision:current}});
 fs.unlinkSync(path.join(f.root,pinFile));fs.symlinkSync(path.join(outside,'source.json'),path.join(f.root,pinFile));assert.throws(()=>readProjects(f.root));
 fs.unlinkSync(path.join(f.root,pinFile));fs.rmdirSync(path.dirname(path.join(f.root,pinFile)));fs.symlinkSync(outside,path.dirname(path.join(f.root,pinFile)));assert.throws(()=>readProjects(f.root));
});

test('object and separately selected origins must match the declared repository',t=>{
 const f=fixture(t);
 f.source({source:{repository:'https://github.com/other/source.git',revision:current}});assert.throws(()=>resolveProject('engine',f.root));
 f.registry.projects[0].upstreams=[{...upstream('scalar','/revision'),pin:{file:pinFile,pointer:'/revision',repositoryPointer:'/origin'}}];f.save();
 f.source({revision:current,origin:'https://github.com/other/source'});assert.throws(()=>readProjects(f.root));
 f.source({revision:current,origin:'https://github.com/owner/source.git'});assert.equal(resolveProject('engine',f.root).upstreams[0].revision,current);
 f.source({revision:current,origin:'https://github.com/owner/source.git?alternate=1'});assert.throws(()=>readProjects(f.root));
 f.source({revision:current});assert.throws(()=>readProjects(f.root));
});

test('derived commit, version and timestamp validation is identical for selected and complete reads',t=>{
 const f=fixture(t);
 for(const source of [null,[],{repository:'https://github.com/owner/source',revision:current,commit:held},{repository:'https://github.com/owner/source',revision:current,version:[]},{repository:'https://github.com/owner/source',revision:current,committedAt:'yesterday'}]){
  f.source({source});assert.throws(()=>readProjects(f.root),undefined,JSON.stringify(source));assert.throws(()=>resolveProject('engine',f.root),undefined,JSON.stringify(source));
 }
});

test('metadata-only reads preserve validated references and selected resolution avoids unrelated checkouts',t=>{
 const missing={...upstream(),pin:{file:'sources/unavailable/source.json',pointer:'/source'}},f=fixture(t,{projects:[project(),project([missing],'unrelated')]});
 assert.deepEqual(readProjects(f.root,{resolvePins:false}),f.registry);assert.deepEqual(resolveProject('unrelated',f.root,{resolvePins:false}).upstreams,[missing]);
 assert.throws(()=>readProjects(f.root));assert.throws(()=>resolveProject('unrelated',f.root));
 assert.equal(resolveProject('engine',f.root).upstreams[0].revision,current);assert.throws(()=>resolveProject('absent',f.root),/Unknown/);
});

test('split registries require canonical references while resolved flat snapshots remain readable',t=>{
 const f=fixture(t),downloadable=project(),bundled=project([],'helper');delete downloadable.delivery;delete bundled.delivery;
 const manifest={schemaVersion:2,repository:'owner/builds',updatePolicy:'manual',registries:{downloadable:'projects/downloadable.json',bundled:'projects/bundled.json'}};
 write(f.root,'projects.json',manifest);write(f.root,'projects/downloadable.json',[downloadable]);write(f.root,'projects/bundled.json',[bundled]);
 const snapshot=readProjects(f.root);assert.equal(snapshot.projects[0].upstreams[0].revision,current);assert.deepEqual(readProjects(f.root,{resolvePins:false}).projects[0].upstreams,[upstream()]);
 const {pin,...description}=downloadable.upstreams[0];downloadable.upstreams=[{...description,revision:current}];write(f.root,'projects/downloadable.json',[downloadable]);
 for(const options of [{},{resolvePins:false}]){
  assert.throws(()=>readProjects(f.root,options));assert.throws(()=>resolveProject('engine',f.root,options));
 }
 write(f.root,'projects.json',snapshot);fs.unlinkSync(path.join(f.root,pinFile));assert.deepEqual(readProjects(f.root),snapshot);assert.equal(resolveProject('engine',f.root).upstreams[0].revision,current);
});

test('held profiles keep distinct canonical pins while update metadata uses the latest resolved selection',async t=>{
 const f=fixture(t,{projects:[project([upstream('current','/profiles/current'),upstream('held','/profiles/held')])],source:{profiles:{current:{repository:'https://github.com/owner/source',revision:current},held:{repository:'https://github.com/owner/source.git',revision:held}}}});
 const calls=[],request=async url=>{calls.push(url);return url.includes('/commits')?[{sha:next,commit:{message:'Upstream update'}}]:[];};
 const first=await checkProjects(readProjects(f.root).projects,{request});assert.deepEqual(first.projects[0].upstreams.map(row=>row.selectedRevision),[current,held]);assert.ok(first.projects[0].upstreams.every(row=>row.headChanged));assert.equal(calls.length,2);
 const bytesBefore=fs.readFileSync(path.join(f.root,'projects.json'));f.source({profiles:{current:{repository:'https://github.com/owner/source',revision:next},held:{repository:'https://github.com/owner/source.git',revision:held}}});calls.length=0;
 const resolved=resolveProject('engine',f.root),second=await checkProjects([resolved],{request});assert.deepEqual(second.projects[0].upstreams.map(row=>row.selectedRevision),[next,held]);assert.deepEqual(second.projects[0].upstreams.map(row=>row.headChanged),[false,true]);assert.equal(calls.length,2);
 assert.equal(second.projects[0].upstreams[0].compareUrl,'https://github.com/owner/source/compare/'+next+'...'+next);assert.deepEqual(fs.readFileSync(path.join(f.root,'projects.json')),bytesBefore);
 const notes=releaseNotes({id:'engine',version:'1.0',arch:'arm64'},resolved);assert.ok(notes.includes('/tree/'+next));assert.ok(notes.includes('/tree/'+held));assert.equal(notes.includes('/tree/'+current),false);
});

test('source-free release preparation and verification work without pin files; staging resolves current pins',async t=>{
 const f=fixture(t,{source:null}),input=path.join(f.root,'input');fs.mkdirSync(input);
 const content={'runtime.json':'{"version":"1.0"}','LICENSE':'MIT'};
 const files=Object.entries(content).map(([name,bytes])=>{fs.writeFileSync(path.join(input,name),bytes,{mode:0o644});return{path:name,size:Buffer.byteLength(bytes),mode:0o644,sha256:digest(bytes)};});
 const declaration={id:'engine',version:'1.0',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',directoryRelative:'engine/1.0/arm64',manifestRelative:'runtime.json',manifestSha256:files[0].sha256,sourceRelative:null,sourceSha256:digest('tag supplied source'),files,notices:[{name:'Engine',license:'MIT',path:'LICENSE'}],redistribution:'bundle'};
 assert.deepEqual(catalogIndex(f.root).projects,[]);
 const bundle=path.join(f.root,'release');await prepareRelease({project:'engine',input,declaration,output:bundle,directory:f.root});
 assert.equal((await verifyRelease({bundle,directory:f.root})).record.version,'1.0');assert.throws(()=>resolveProject('engine',f.root));
 const calls=[],runGh=async args=>{calls.push(args);if(args[0]==='api')return JSON.stringify({object:{sha:target,type:'commit'}});return '';};
 await assert.rejects(stageRelease({bundle,target,directory:f.root,runGh}));assert.equal(calls.length,0);
 f.source({source:{repository:'https://github.com/owner/source.git',revision:next}});
 await stageRelease({bundle,target,directory:f.root,runGh});assert.equal(calls.length,2);
 const upload=calls.find(args=>args[0]==='release');assert.ok(upload);assert.ok(upload[upload.indexOf('--notes')+1].includes('https://github.com/owner/source/tree/'+next));
 assert.deepEqual(upload.filter(arg=>arg.startsWith(bundle)),[path.join(bundle,'engine-1.0-arm64.tar.gz')]);assert.equal(calls.some(args=>args.includes('POST')),false);
});
