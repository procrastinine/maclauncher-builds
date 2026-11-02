import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';

function fixture(t,files){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-modules-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(directory,file)),{recursive:true});fs.writeFileSync(path.join(directory,file),typeof value==='string'?value:JSON.stringify(value));};
 const project={id:'recipe',name:'recipe',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['tools/recipe.cjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:'recipe'}],build:{version:'1.0.0',architectures:['arm64'],command:'tools/recipe.cjs'}};
 write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[project]});
 for(const [file,value] of Object.entries(files))write(file,value);
 // Tracked files let the report name computed paths that match repository files.
 execFileSync('git',['init','-q'],{cwd:directory});execFileSync('git',['add','-A'],{cwd:directory});
 return {directory,write};
}

test('recipe definitions follow local modules and files the way Node resolves them',t=>{
 const f=fixture(t,{
  'tools/recipe.cjs':['const path = require("node:path");','const helper = require("./helper");','const index = require("./helpers");','const pin = require("./pin.json");',
   'const resolved = require.resolve("../lib/resolved");','const overlay = path.join(__dirname, "overlays", "fix.lua");','const output = path.join(__dirname, "generated.bin");',
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
