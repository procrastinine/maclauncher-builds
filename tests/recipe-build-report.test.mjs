import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';

const project=(id,command)=>({id,name:id,delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:[command]},upstreams:[],packageProfiles:[{version:'1.0.0',label:id}],build:{version:'1.0.0',architectures:['arm64'],command}});

function fixture(t,files,projects=[project('recipe','tools/recipe.cjs')]){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-modules-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(directory,file)),{recursive:true});fs.writeFileSync(path.join(directory,file),typeof value==='string'?value:JSON.stringify(value));};
 write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects});
 for(const [file,value] of Object.entries(files))write(file,value);
 // Tracked files let the report name computed paths that match repository files.
 execFileSync('git',['init','-q'],{cwd:directory});execFileSync('git',['add','-A'],{cwd:directory});
 return {directory,write};
}

test('recipe definitions follow local modules and files the way Node resolves them',t=>{
 const f=fixture(t,{
  'tools/recipe.cjs':['const path = require("node:path");','const helper = require("./helper");','const index = require("./helpers");','const pin = require("./pin.json");',
   'const resolved = '+['require','resolve'].join('.')+'('+JSON.stringify('../lib/resolved')+');','const overlay = path.join(__dirname, "overlays", "fix.lua");','const output = path.join(__dirname, "generated.bin");',
   'const named = path.join(variable, "named.cjs");',''].join('\n'),
  'tools/helper.js':'module.exports = require("./nested");\n','tools/nested.cjs':'module.exports = 1;\n','tools/helpers/index.js':'module.exports = 2;\n',
  'tools/pin.json':{version:'1.0.0'},'tools/overlays/fix.lua':'return 1\n','lib/named.cjs':'module.exports = 4;\n',
  'lib/resolved.mjs':'export const data = new URL("./data.bin", import.meta.url);\n','lib/data.bin':'data'});
 const describe=createRecipeBuildReporter({directory:f.directory}),report=describe('recipe');
 // Extensionless and .cjs probing, a directory index, require.resolve, a JSON require, __dirname joins and URL references.
 assert.deepEqual(report.definition.files.map(file=>file.path).sort(),['lib/data.bin','lib/resolved.mjs','tools/helper.js','tools/helpers/index.js','tools/nested.cjs','tools/overlays/fix.lua','tools/pin.json','tools/recipe.cjs']);
 assert.deepEqual(describe.unresolved('recipe'),[
  {file:'tools/recipe.cjs',expression:'path.join(__dirname, "generated.bin")',reason:'missing'},
  {file:'tools/recipe.cjs',expression:'path.join(variable, "named.cjs")',reason:'computed',matches:['lib/named.cjs']}]);
 f.write('tools/nested.cjs','module.exports = 5;\n');
 assert.notEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definitionDigest,report.definitionDigest);
});

test('a build command shared by several projects reports each project its own inputs',t=>{
 const files={'tools/input.mjs':'export const input = true;\n','tools/shared.mjs':"function audio(){return preparedBuildInput('input');}\n"};
 const projects=[project('first','tools/shared.mjs'),project('second','tools/shared.mjs'),project('input','tools/input.mjs')];
 const f=fixture(t,files,projects);
 assert.throws(()=>createRecipeBuildReporter({directory:f.directory})('second'),/shared build command tools\/shared\.mjs must report the inputs of second/);
 f.write('tools/shared.mjs',files['tools/shared.mjs']+"export function recipeInputs({project}){return project==='first'?['input']:[];}\n");
 const describe=createRecipeBuildReporter({directory:f.directory});
 assert.deepEqual(describe('first').inputs,[{id:'input'}]);assert.deepEqual(describe('second').inputs,[]);
});

test('a directory entry declares every tracked file below it',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.entries.push('native/base');
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n','native/base/src/compile.cpp':'int main() {}\n','native/base/THIRD_PARTY.md':'notices\n','native/other.cpp':'int other;\n'},[recipe]);
 assert.deepEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definition.files.map(file=>file.path).sort(),['native/base/THIRD_PARTY.md','native/base/src/compile.cpp','tools/recipe.cjs']);
});

test('publication changes leave every package definition unchanged',t=>{
 const f=fixture(t,{'tools/first.cjs':'require("./pack");','tools/second.cjs':'require("./pack");','tools/pack.js':'exports.pack = () => 1; exports.catalog = () => import("./publication/catalog.mjs");','tools/publication/catalog.mjs':'export const publish = 1;'},[project('first','tools/first.cjs'),project('second','tools/second.cjs')]);
 const digests=()=>{const describe=createRecipeBuildReporter({directory:f.directory});return ['first','second'].map(id=>describe(id).definitionDigest);};
 const before=digests();f.write('tools/publication/catalog.mjs','export const publish = 2;');assert.deepEqual(digests(),before);
 f.write('tools/first.cjs','require("./pack"); exports.changed = true;');const recipe=digests();assert.notEqual(recipe[0],before[0]);assert.equal(recipe[1],before[1]);
 f.write('tools/pack.js','exports.pack = () => 2; exports.catalog = () => import("./publication/catalog.mjs");');const packed=digests();assert.notEqual(packed[0],recipe[0]);assert.notEqual(packed[1],recipe[1]);
});

test('the shared build action and the package commands it runs are sealed build inputs',t=>{
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};','.github/actions/build-runtime/action.yml':'runs:\n  steps:\n    - run: node tools/package.mjs prepare\n    - uses: ./.github/actions/network\n','.github/actions/network/action.yml':'runs:\n  using: node24\n  main: ../../../tools/network-action.cjs\n','tools/network-action.cjs':'require("./download.mjs");','tools/download.mjs':'export const retryNetwork = true;','tools/package.mjs':'export const pack = 1;'});
 const report=()=>createRecipeBuildReporter({directory:f.directory})('recipe');const before=report();
 assert.ok(before.definition.files.some(file=>file.path==='.github/actions/build-runtime/action.yml'));
 assert.ok(before.definition.files.some(file=>file.path==='tools/package.mjs'));
 for(const file of ['.github/actions/network/action.yml','tools/network-action.cjs','tools/download.mjs'])assert.ok(before.definition.files.some(row=>row.path===file),file);
 f.write('tools/package.mjs','export const pack = 2;');assert.notEqual(report().definitionDigest,before.definitionDigest);
});

test('every production definition excludes publication, catalog and planning files',async()=>{
 const directory=path.resolve(import.meta.dirname,'..'),{readProjects}=await import('../lib/projects.mjs'),describe=createRecipeBuildReporter({directory});
 for(const project of readProjects(directory,{resolvePins:false}).projects.filter(project=>project.build)){
  for(const file of describe(project.id).definition.files)assert.doesNotMatch(file.path,/^tools\/(?:publication\/|publish-|plan-|dispatch-|catalog-|package-index|release-runtime|publication-authority)/,project.id+': '+file.path);
 }
});
