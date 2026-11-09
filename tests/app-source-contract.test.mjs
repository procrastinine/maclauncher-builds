import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readProjects} from '../lib/projects.mjs';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';

const root=path.resolve(import.meta.dirname,'..');
const appSource=path.join(root,'sources/maclauncher');
const tracked=(...patterns)=>execFileSync('git',['-C',root,'ls-files','-s','-z','--',...patterns],{encoding:'utf8',maxBuffer:Infinity}).split('\0').filter(Boolean).map(row=>{const [mode,,,]=row.split(/\s/);return {mode,file:row.slice(row.indexOf('\t')+1)};});

test('no tracked link points into the pinned app source',()=>{
 const links=tracked().filter(row=>row.mode==='120000').map(row=>row.file).filter(file=>{
  const target=path.resolve(path.dirname(path.join(root,file)),execFileSync('git',['-C',root,'cat-file','blob',':'+file],{encoding:'utf8'}));
  return target===appSource||target.startsWith(appSource+path.sep);
 });
 assert.deepEqual(links,[]);
});

test('every project resolves its recipe inputs, app files and source records',{skip:!fs.existsSync(path.join(appSource,'.git'))&&'Requires the pinned app source'},()=>{
 const describe=createRecipeBuildReporter({directory:root}),problems=[];
 for(const project of readProjects(root,{resolvePins:false}).projects.filter(project=>project.build)){
  describe(project.id);
  for(const row of describe.unresolved(project.id).filter(row=>row.reason!=='computed'))problems.push({project:project.id,...row});
 }
 assert.deepEqual(problems,[]);
});

// A source record's pin is read only through lib/pins.mjs. This finds pin
// fields read directly from a value parsed or imported from JSON.
test('source record pins are read only through the shared reader',()=>{
 const reads=[];
 for(const {file} of tracked('*.mjs','*.js','*.cjs')){
  if(file.startsWith('sources/')||file.startsWith('tests/')||file==='lib/pins.mjs')continue;
  const text=fs.readFileSync(path.join(root,file),'utf8'),names=new Set();
  for(const match of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:JSON\.parse\(|require\(\s*['"][^'"]+\.json['"]|await\s+import\(\s*['"][^'"]+\.json)/g))names.add(match[1]);
  for(const match of text.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+\.json['"]/g))names.add(match[1]);
  for(const name of names)for(const match of text.matchAll(new RegExp('(?<![\\w$.])'+name.replace(/\$/g,'\\$')+'(?:\\??\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])*\\??\\.(?:revision|gitlink|commit)\\b','g')))reads.push(file+': '+match[0]);
 }
 assert.deepEqual(reads,[]);
});
