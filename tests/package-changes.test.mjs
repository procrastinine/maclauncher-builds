import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {packageChanges} from '../lib/package-changes.mjs';
import {treeSource} from '../lib/tree-source.mjs';
import {readProjects,resolveProject,buildRecord,declaredRecipeEntries} from '../lib/projects.mjs';
import {registerSelection} from '../tools/release-selection.mjs';
import {canonicalReport} from '../lib/canonical-report.mjs';

const root=path.resolve(import.meta.dirname,'..');
function fixture(t){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'changes-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q');git('config','user.name','procrastinine');
 git('config','user.email','24549552+procrastinine@users.noreply.github.com');
 const write=(file,value)=>{
  const target=path.join(directory,file);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,typeof value==='string'?value:JSON.stringify(value,null,2));
 };
 const project={id:'demo',name:'Demo',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['recipe.mjs']},
  upstreams:[{id:'source',provider:'github',repository:'owner/source',url:'https://github.com/owner/source',pin:{file:'source.json',pointer:''}}],
  packageProfiles:[{version:'1.0.0',label:'Demo'}],build:{version:'1.0.0',command:'tools/build.mjs',architectures:['arm64'],notes:'Initial package.'}};
 const projects=[project];
 const registry=()=>write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects});
 const commit=subject=>{registry();git('add','.');git('commit','-qm',subject);return git('rev-parse','HEAD');};
 write('recipe.mjs','// first\n');write('tools/build.mjs','// command\n');
 write('source.json',{repository:'https://github.com/owner/source',revision:'1'.repeat(40)});
 return {directory,git,write,project,projects,registry,commit};
}

test('catalog versions alone determine history, input deltas, scoped commits, notes and first release',t=>{
 const f=fixture(t),first=f.commit('Initial recipe');
 f.project.build={...f.project.build,version:'1.1.0'};delete f.project.build.notes;
 f.project.packageProfiles.push({version:'1.1.0',label:'Demo 1.1'});
 f.write('source.json',{repository:'https://github.com/owner/source',revision:'2'.repeat(40)});
 f.write('recipe.mjs','// second\n');const second=f.commit('Update demo recipe');
 f.projects.push({...structuredClone(f.project),id:'other',name:'Other project'});
 f.write('producers/other/recipe.mjs','// unrelated producer\n');
 const third=f.commit('Change only another project declaration and producer');
 f.git('tag','demo/v9.9.9/arm64');
 const records=[{version:'1.0.0',arch:'arm64',build:{sourceRevision:first}},
  {version:'1.1.0',arch:'arm64',build:{sourceRevision:second}},
  {version:'1.1.0',arch:'x64',build:{sourceRevision:second}},
  {version:'1.2.0',arch:'arm64',source:{repository:'owner/builds',revision:third}}];
 f.write('catalogs/demo.json',{schemaVersion:2,projectId:'demo',packages:records});
 const result=packageChanges({directory:f.directory}),[initial,updated,last]=result.projects[0].releases;
 assert.deepEqual(result.projects[0].releases.map(r=>r.version),['1.0.0','1.1.0','1.2.0']);
 assert.equal(initial.previousVersion,null);assert.deepEqual(initial.commits,[]);
 assert.equal(initial.notes,'Initial package.');assert.ok(initial.inputs.every(input=>input.before===null));
 assert.equal(updated.previousVersion,'1.0.0');assert.equal(updated.notes,undefined);
 assert.deepEqual(updated.architectures,['arm64','x64']);
 assert.deepEqual(updated.commits.map(commit=>commit.subject),['Update demo recipe']);
 assert.equal(updated.inputs[0].before.revision,'1'.repeat(40));
 assert.equal(updated.inputs[0].after.revision,'2'.repeat(40));
 assert.deepEqual(last.inputs,[]);assert.deepEqual(last.commits,[]);
 assert.equal(canonicalReport(result),canonicalReport(packageChanges({directory:f.directory})));
});

test('historical JavaScript pins are unrecorded data, never parsed or executed',t=>{
 const f=fixture(t);
 f.project.upstreams[0].pin={file:'producers/source.cjs',pointer:'/REVISION'};
 f.write('producers/source.cjs',"throw Error('Do not execute'); exports.REVISION='"+'a'.repeat(40)+"';");
 const revision=f.commit('Historical module');
 f.write('catalogs/demo.json',{projectId:'demo',packages:[{version:'1.0.0',arch:'arm64',build:{sourceRevision:revision}}]});
 const entry=packageChanges({directory:f.directory}).projects[0].releases[0];
 assert.deepEqual(entry.inputs,[]);assert.equal(entry.unrecordedInputs[0].name,'source');
 assert.match(entry.unrecordedInputs[0].reason,/JSON data only/);
 assert.equal(fs.readFileSync(path.join(f.directory,'producers/source.cjs'),'utf8').startsWith('throw'),true);
});

test('new versions do not inherit notes and invalid notes are rejected',t=>{
 const f=fixture(t);f.commit('Initial recipe');
 registerSelection({directory:f.directory,selection:'demo=2.0.0'});
 assert.equal(readProjects(f.directory,{resolvePins:false}).projects[0].build.notes,undefined);
 for(const notes of ['',42,'a\nb'])assert.throws(()=>buildRecord({...f.project,build:{...f.project.build,notes}}),/notes/);
});

test('Git-tree HEAD resolution equals working-tree resolution for every registered project',()=>{
 const working=treeSource(root),committed=treeSource(root,{at:'HEAD'});
 for(const project of readProjects(root,{resolvePins:false}).projects){
  assert.deepEqual(resolveProject(project.id,{directory:root,source:committed}),
   resolveProject(project.id,{directory:root,source:working}),project.id);
 }
});

test('real changelog project ids and versions exactly equal the catalogs without altering bytes',()=>{
 const files=fs.readdirSync(path.join(root,'catalogs')).filter(file=>file.endsWith('.json')&&file!=='index.json').sort();
 const original=files.map(file=>fs.readFileSync(path.join(root,'catalogs',file)));
 const expected=files.map((file,i)=>{
  const catalog=JSON.parse(original[i]);
  return {projectId:catalog.projectId,versions:[...new Set(catalog.packages.map(record=>record.version))].sort()};
 }).sort((a,b)=>a.projectId<b.projectId?-1:1);
 const changes=packageChanges({directory:root});
 assert.deepEqual(changes.projects.map(project=>({projectId:project.projectId,versions:project.releases.map(r=>r.version).sort()})),expected);
 for(const [i,file] of files.entries())assert.deepEqual(fs.readFileSync(path.join(root,'catalogs',file)),original[i]);
});

test('missing Builds commits and conflicting architecture records never abort the history',t=>{
 const f=fixture(t),first=f.commit('Initial recipe');
 f.write('recipe.mjs','// changed\n');const second=f.commit('Recipe update');
 f.write('catalogs/demo.json',{projectId:'demo',packages:[
  {version:'1.0.0',arch:'arm64',build:{sourceRevision:first}},
  {version:'1.1.0',arch:'arm64',build:{sourceRevision:first}},
  {version:'1.1.0',arch:'x64',build:{sourceRevision:second}},
  {version:'1.2.0',arch:'arm64',build:{sourceRevision:'f'.repeat(40)}}
 ]});
 const releases=packageChanges({directory:f.directory}).projects[0].releases;
 assert.equal(releases.length,3);
 assert.equal(releases[1].sourceRevision,null);
 assert.match(releases[1].unrecordedInputs[0].reason,/different Builds commits/);
 assert.ok(releases[2].unrecordedInputs.some(input=>input.name==='sourceRevision'));
});

test('source subjects use consumed paths and shallow submodules retain pins without partial history',t=>{
 const f=fixture(t);
 const upstream=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'changes-upstream-'));
 const run=(directory,...args)=>execFileSync('git',['-C',directory,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe']
 }).trim();
 t.after(()=>fs.rmSync(upstream,{recursive:true,force:true}));
 run(upstream,'init','-q');run(upstream,'config','user.name','procrastinine');
 run(upstream,'config','user.email','24549552+procrastinine@users.noreply.github.com');
 fs.writeFileSync(path.join(upstream,'consumed.txt'),'first');
 fs.writeFileSync(path.join(upstream,'other.txt'),'first');
 fs.writeFileSync(path.join(upstream,'pin.json'),JSON.stringify({revision:'a'.repeat(40)}));
 const commit=subject=>{
  run(upstream,'add','.');run(upstream,'commit','-qm',subject);
  return run(upstream,'rev-parse','HEAD');
 };
 const before=commit('Original source');
 fs.writeFileSync(path.join(upstream,'consumed.txt'),'second');commit('Consumed source correction');
 fs.writeFileSync(path.join(upstream,'other.txt'),'second');const after=commit('Unrelated source edit');
 const checkout=path.join(f.directory,'sources/engine');
 fs.mkdirSync(path.dirname(checkout),{recursive:true});
 run(upstream,'worktree','add','--detach',checkout,after);
 f.write('.gitmodules','[submodule "engine"]\n path = sources/engine\n url = https://github.com/owner/source\n');
 f.project.producer.entries.push('sources/engine/consumed.txt');
 f.project.build.submodules=['sources/engine'];
 f.project.upstreams[0].pin={gitlink:'sources/engine'};
 f.project.upstreams.push({id:'nested',provider:'github',repository:'owner/nested',
  url:'https://github.com/owner/nested',pin:{file:'sources/engine/pin.json',pointer:''}});
 f.git('add','.');f.git('update-index','--cacheinfo','160000,'+before+',sources/engine');
 // Stage the recorded Gitlink without replacing it with the checkout's current HEAD.
 const save=subject=>{
  f.registry();f.git('add','projects.json');f.git('commit','-qm',subject);
  return f.git('rev-parse','HEAD');
 };
 const first=save('Package original source');
 f.git('update-index','--cacheinfo','160000,'+after+',sources/engine');
 const second=save('Package corrected source');
 f.write('catalogs/demo.json',{projectId:'demo',packages:[
  {version:'1.0.0',arch:'arm64',build:{sourceRevision:first}},
  {version:'1.1.0',arch:'arm64',build:{sourceRevision:second}}
 ]});
 let release=packageChanges({directory:f.directory}).projects[0].releases.at(-1);
 assert.deepEqual(release.commits.filter(row=>row.repository).map(row=>row.subject),['Consumed source correction']);
 run(upstream,'worktree','remove','--force',checkout);
 fs.mkdirSync(checkout);run(checkout,'init','-q');
 run(checkout,'fetch','--depth=1','file://'+upstream,after);
 run(checkout,'checkout','--detach','FETCH_HEAD');
 assert.equal(run(checkout,'rev-parse','--is-shallow-repository'),'true');
 let changes=packageChanges({directory:f.directory});
 assert.ok(changes.projects[0].releases[0].unrecordedInputs.some(input=>input.name==='nested'));
 release=changes.projects[0].releases.at(-1);
 assert.deepEqual(release.commits.filter(row=>row.repository),[]);
 assert.ok(release.unrecordedInputs.some(input=>input.name==='commits:gitlink:sources/engine'));
 const pin=release.inputs.find(input=>input.name==='gitlink:sources/engine');
 assert.equal(pin.before.revision,before);assert.equal(pin.after.revision,after);
 // Both endpoints may exist while a shallow boundary still hides the commits between them.
 run(checkout,'fetch','--depth=1','file://'+upstream,before);
 release=packageChanges({directory:f.directory}).projects[0].releases.at(-1);
 assert.deepEqual(release.commits.filter(row=>row.repository),[]);
 assert.ok(release.unrecordedInputs.some(input=>input.name==='commits:gitlink:sources/engine'));
});

test('project Markdown notes affect exactly named published versions; unknown headings only warn',t=>{
 const f=fixture(t);
 f.projects.push({...structuredClone(f.project),id:'control',name:'Control'});
 const first=f.commit('Initial recipes');
 f.write('recipe.mjs','// updated\n');const second=f.commit('Recipe change');
 for(const id of ['demo','control'])f.write('catalogs/'+id+'.json',{projectId:id,packages:[
  {version:'1.1.0',arch:'arm64',build:{sourceRevision:second}},
  {version:'1.0.0',arch:'arm64',build:{sourceRevision:first}}
 ]});
 const before=packageChanges({directory:f.directory});
 f.write('releases.txt','demo=2.0.0');
 f.write('changelog/demo.md','# Demo\n\n## 2.0.0\n\nPending note.\n\n## 1.1.0\n\n**New option**.\n\n- Retains settings.\n\n## 9.9.9\n\nUnmatched note.\n');
 const warnings=[];
 const after=packageChanges({directory:f.directory,warn:message=>warnings.push(message)});
 const demo=after.projects.find(project=>project.projectId==='demo');
 assert.equal(demo.releases.find(release=>release.version==='1.1.0').notes,'**New option**.\n\n- Retains settings.');
 assert.equal(demo.releases.find(release=>release.version==='1.0.0').notes,undefined);
 assert.deepEqual(after.projects.find(project=>project.projectId==='control'),before.projects.find(project=>project.projectId==='control'));
 assert.equal(warnings.length,1);assert.match(warnings[0],/9\.9\.9/);
});


test('package source paths exclude global orchestration and narrow materialized app directories',()=>{
 const project={producer:{entries:['producers/demo','producers/shared/build.mjs','tools/source.mjs'],
  appEntries:['package.json','src/graphics']},build:{command:'tools/build-demo.mjs'}};
 const manifest={buildCode:['tools/source.mjs','lib/projects.mjs']};
 const source={files:entry=>entry==='producers/demo'?['producers/demo/materialization.json']:[],
  json:()=>({files:[{source:'app:src/graphics/native/source.mm',path:'source.mm'}]})};
 assert.deepEqual(declaredRecipeEntries(project,manifest,{packageSources:true,source}),[
  'app:src/graphics/native/source.mm','producers/demo','producers/shared/build.mjs','tools/build-demo.mjs'
 ]);
 assert.ok(declaredRecipeEntries(project,manifest).includes('tools/source.mjs'));
});


test('package source paths add the recipe import closure, without the shared build code closure',()=>{
 const files={'tools/build-demo.mjs':'import "./own.mjs";\nimport "./shared-helper.mjs";\n','tools/own.mjs':'export {};\n',
  'tools/shared-helper.mjs':'export {};\n','tools/orchestrate.mjs':'import "./shared-helper.mjs";\n'};
 const source={files:entry=>Object.keys(files).filter(file=>file===entry||file.startsWith(entry+'/')),readFile:file=>files[file],json:()=>({})};
 const project={producer:{entries:[]},build:{command:'tools/build-demo.mjs'}},manifest={buildCode:['tools/orchestrate.mjs']};
 assert.deepEqual(declaredRecipeEntries(project,manifest,{packageSources:true,source}),['tools/build-demo.mjs','tools/own.mjs']);
 assert.deepEqual(declaredRecipeEntries(project,manifest,{source}),['tools/build-demo.mjs','tools/orchestrate.mjs','tools/own.mjs','tools/shared-helper.mjs']);
});


test('shared recipe helpers remain in scope while another producer-only request stays out',t=>{
 const f=fixture(t);
 f.project.producer.entries.push('tools/shared.mjs');
 f.write('tools/shared.mjs','// original');
 const first=f.commit('Original packages');
 f.write('tools/shared.mjs','// shared correction');
 const second=f.commit('Correct a shared recipe helper');
 f.projects.push({...structuredClone(f.project),id:'other',name:'Other'});
 f.write('tools/shared.mjs','// other producer support');
 f.write('producers/other/build.mjs','// other recipe');
 const third=f.commit('Declare another producer and extend its shared helper');
 f.write('catalogs/demo.json',{projectId:'demo',packages:[
  {version:'1.0.0',arch:'arm64',build:{sourceRevision:first}},
  {version:'1.1.0',arch:'arm64',build:{sourceRevision:third}}
 ]});
 const release=packageChanges({directory:f.directory}).projects[0].releases.at(-1);
 assert.deepEqual(release.commits.map(commit=>commit.revision),[second]);
});
