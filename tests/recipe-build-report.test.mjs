import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';

const project=(id,command)=>({id,name:id,delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:[command]},upstreams:[],packageProfiles:[{version:'1.0.0',label:id}],build:{version:'1.0.0',architectures:['arm64'],command}});

function fixture(t,files,projects=[project('recipe','tools/recipe.cjs')],buildCode){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-modules-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(directory,file)),{recursive:true});fs.writeFileSync(path.join(directory,file),typeof value==='string'?value:JSON.stringify(value));};
 write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects,...(buildCode?{buildCode}:{})});
 for(const [file,value] of Object.entries(files))write(file,value);
 execFileSync('git',['init','-q'],{cwd:directory});execFileSync('git',['add','-A'],{cwd:directory});
 return {directory,write};
}
const paths=report=>report.definition.files.map(file=>file.path).sort();

test('a definition holds exactly the declared inputs, never files discovered from code',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.entries.push('tools/helpers','tools/missing.cjs');
 const f=fixture(t,{'tools/recipe.cjs':'require("./helpers"); require("./undeclared.cjs"); require("../lib/shared.mjs");\n','tools/helpers/index.js':'module.exports = 1;\n','tools/helpers/data.json':{version:'1.0.0'},
  'tools/undeclared.cjs':'module.exports = 2;\n','lib/shared.mjs':'export const shared = 1;\n'},[recipe],['lib/shared.mjs']);
 const describe=createRecipeBuildReporter({directory:f.directory}),report=describe('recipe');
 assert.deepEqual(paths(report),['lib/shared.mjs','tools/helpers/data.json','tools/helpers/index.js','tools/recipe.cjs']);
 assert.deepEqual(describe.unresolved('recipe'),[{file:'projects',expression:'tools/missing.cjs',reason:'missing'}]);
 f.write('tools/undeclared.cjs','module.exports = 3;\n');assert.equal(createRecipeBuildReporter({directory:f.directory})('recipe').definitionDigest,report.definitionDigest);
 f.write('tools/helpers/index.js','module.exports = 4;\n');assert.notEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definitionDigest,report.definitionDigest);
});

test('each project declares its own package inputs, also when projects share a command',t=>{
 const first=project('first','tools/shared.mjs'),second=project('second','tools/shared.mjs'),unknown=project('unknown','tools/shared.mjs');
 first.build.inputs=['input'];unknown.build.inputs=['absent'];
 const f=fixture(t,{'tools/input.mjs':'export const input = true;\n','tools/shared.mjs':'export const shared = true;\n'},[first,second,unknown,project('input','tools/input.mjs')]);
 const describe=createRecipeBuildReporter({directory:f.directory});
 assert.deepEqual(describe('first').inputs,[{id:'input'}]);assert.deepEqual(describe('second').inputs,[]);
 assert.deepEqual(describe.unresolved('unknown'),[{file:'projects',expression:'absent',reason:'input',problem:'A package input names another registered project.'}]);
});

test('declared records and pins are validated once, by the resolver',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.entries.push('tools/source.json');
 recipe.upstreams=[{id:'engine',provider:'github',url:'https://github.com/owner/engine',repository:'owner/engine',revision:'1'.repeat(40),pin:{file:'tools/source.json',pointer:'/engine'}}];
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n','tools/source.json':{engine:{repository:'https://github.com/owner/engine',commit:'2'.repeat(40)}}},[recipe]);
 assert.deepEqual(createRecipeBuildReporter({directory:f.directory}).unresolved('recipe').map(row=>[row.reason,row.problem]),[
  ['pin','A referenced source pin cannot also declare a revision, version or timestamp override.'],
  ['record','A source record names its exact commit as revision.'],
  ['record','A source record names its exact commit as revision.']]);
});

test('a directory entry declares every tracked file below it',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.entries.push('native/base');
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n','native/base/src/compile.cpp':'int main() {}\n','native/base/THIRD_PARTY.md':'notices\n','native/other.cpp':'int other;\n'},[recipe]);
 assert.deepEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definition.files.map(file=>file.path).sort(),['native/base/THIRD_PARTY.md','native/base/src/compile.cpp','tools/recipe.cjs']);
});

test('publication changes leave every package definition unchanged',t=>{
 const f=fixture(t,{'tools/first.cjs':'require("./pack");','tools/second.cjs':'require("./pack");','tools/pack.js':'exports.pack = () => 1; exports.catalog = () => import("./publication/catalog.mjs");','tools/publication/catalog.mjs':'export const publish = 1;'},[project('first','tools/first.cjs'),project('second','tools/second.cjs')],['tools/pack.js']);
 const digests=()=>{const describe=createRecipeBuildReporter({directory:f.directory});return ['first','second'].map(id=>describe(id).definitionDigest);};
 const before=digests();f.write('tools/publication/catalog.mjs','export const publish = 2;');assert.deepEqual(digests(),before);
 f.write('tools/first.cjs','require("./pack"); exports.changed = true;');const recipe=digests();assert.notEqual(recipe[0],before[0]);assert.equal(recipe[1],before[1]);
 f.write('tools/pack.js','exports.pack = () => 2; exports.catalog = () => import("./publication/catalog.mjs");');const packed=digests();assert.notEqual(packed[0],recipe[0]);assert.notEqual(packed[1],recipe[1]);
});

test('the shared build action and the tools it runs are declared build code',t=>{
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};','.github/actions/build-runtime/action.yml':'runs:\n  steps:\n    - run: node tools/package.mjs prepare\n    - uses: ./.github/actions/network\n','.github/actions/network/action.yml':'runs:\n  using: node24\n  main: ../../../tools/network-action.cjs\n','tools/network-action.cjs':'require("./download.mjs");','tools/download.mjs':'export const retryNetwork = true;','tools/package.mjs':'export const pack = 1;'},undefined,['.github/actions','tools/download.mjs','tools/network-action.cjs','tools/package.mjs']);
 const report=()=>createRecipeBuildReporter({directory:f.directory})('recipe');const before=report();
 assert.deepEqual(paths(before),['.github/actions/build-runtime/action.yml','.github/actions/network/action.yml','tools/download.mjs','tools/network-action.cjs','tools/package.mjs','tools/recipe.cjs']);
 f.write('tools/package.mjs','export const pack = 2;');assert.notEqual(report().definitionDigest,before.definitionDigest);
});

test('every production definition excludes publication, catalog and planning files',async()=>{
 const directory=path.resolve(import.meta.dirname,'..'),{readProjects}=await import('../lib/projects.mjs'),describe=createRecipeBuildReporter({directory});
 for(const project of readProjects(directory,{resolvePins:false}).projects.filter(project=>project.build)){
  for(const file of describe(project.id).definition.files)assert.doesNotMatch(file.path,/^tools\/(?:publication\/|publish-|plan-|dispatch-|catalog-|package-index|release-runtime|publication-authority)/,project.id+': '+file.path);
 }
});
