import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {packageChanges} from '../lib/package-changes.mjs';
import {treeSource} from '../lib/tree-source.mjs';
import {readProjects,resolveProject,buildRecord} from '../lib/projects.mjs';
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
 const registry=()=>write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[project]});
 const commit=subject=>{registry();git('add','.');git('commit','-qm',subject);return git('rev-parse','HEAD');};
 write('recipe.mjs','// first\n');write('tools/build.mjs','// command\n');
 write('source.json',{repository:'https://github.com/owner/source',revision:'1'.repeat(40)});
 return {directory,git,write,project,registry,commit};
}

test('catalog versions alone determine history, input deltas, scoped commits, notes and first release',t=>{
 const f=fixture(t),first=f.commit('Initial recipe');
 f.project.build={...f.project.build,version:'1.1.0'};delete f.project.build.notes;
 f.project.packageProfiles.push({version:'1.1.0',label:'Demo 1.1'});
 f.write('source.json',{repository:'https://github.com/owner/source',revision:'2'.repeat(40)});
 f.write('recipe.mjs','// second\n');const second=f.commit('Update demo recipe');
 f.write('unrelated.txt','unrelated');const third=f.commit('Unrelated change');
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
