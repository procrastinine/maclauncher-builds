import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {APP_REFERENCE,appSourceRoot} from '../tools/app-source.mjs';
import {readProjects} from '../lib/projects.mjs';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';

const root=path.resolve(import.meta.dirname,'..');
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:Infinity});
const tree=directory=>git(directory,['ls-tree','-r','-z','HEAD']).split('\0').filter(Boolean).map(row=>{const [meta,file]=row.split('\t'),[mode,type,object]=meta.split(' ');return {mode,type,object,file};});
const builds=tree(root).filter(row=>!row.file.startsWith('sources/'));

// The effects of reading the app in place: no link into it, no copy of it,
// and source record pins read only through lib/pins.mjs.
test('no tracked link points into the pinned app source',()=>{
 const app=appSourceRoot().directory;
 const links=builds.filter(row=>row.mode==='120000').map(row=>row.file).filter(file=>{
  const target=path.resolve(path.dirname(path.join(root,file)),git(root,['cat-file','blob',`HEAD:${file}`]));
  return target===app||target.startsWith(app+path.sep);
 });
 assert.deepEqual(links,[]);
});

// License texts are excluded: their handling is shared and never fails.
const license=file=>/(?:^|\/)licenses\//.test(file)||/^(?:LICENSE|COPYING|NOTICE)/i.test(path.posix.basename(file));
test('no Builds file is a copy of an app file at the pinned commit',()=>{
 const app=new Map(tree(appSourceRoot().directory).filter(row=>row.type==='blob').map(row=>[row.object,row.file]));
 assert.deepEqual(builds.filter(row=>row.type==='blob'&&app.has(row.object)&&!license(row.file)).map(row=>row.file+' = app:'+app.get(row.object)),[]);
});

test('source record pins are read only through the shared reader',()=>{
 // A value parsed from a JSON file that is not a Builds or app file (an
 // upstream's own data, such as a fetched archive's manifest) is not a record.
 const records=new Set([...builds.map(row=>path.posix.basename(row.file)),...tree(appSourceRoot().directory).map(row=>path.posix.basename(row.file))].filter(name=>name.endsWith('.json')));
 const reads=[];
 for(const {file} of builds.filter(row=>/\.(?:mjs|js|cjs)$/.test(row.file)&&!row.file.startsWith('tests/')&&row.file!=='lib/pins.mjs')){
  const text=fs.readFileSync(path.join(root,file),'utf8'),names=new Set();
  for(const match of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(JSON\.parse\(|require\(\s*['"][^'"]+\.json['"]|await\s+import\(\s*['"][^'"]+\.json)([^;\n]*)/g)){
   const literal=/['"]([^'"]+\.json)['"]/.exec(match[2]+match[3]);
   if(!literal||records.has(path.posix.basename(literal[1])))names.add(match[1]);
  }
  for(const match of text.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+\.json['"]/g))names.add(match[1]);
  for(const name of names)for(const match of text.matchAll(new RegExp('(?<![\\w$.])'+name.replace(/\$/g,'\\$')+'(?:\\??\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])*\\??\\.(?:revision|gitlink|commit)\\b','g')))reads.push(file+': '+match[0]);
 }
 assert.deepEqual(reads,[]);
});

// A revision or digest is declared once among the gitlinks and the files
// packages read, so a change to it is one edit in one place.
test('no pin or digest is declared in two places',()=>{
 const describe=createRecipeBuildReporter({directory:root}),inputs=new Set(),declared=new Map(),app=appSourceRoot().directory;
 for(const project of readProjects(root,{resolvePins:false}).projects.filter(project=>project.build))for(const file of describe(project.id).definition.files)inputs.add(file.path);
 for(const file of [...inputs].filter(file=>/\.(?:json|[mc]?js)$/.test(file))){
  const text=fs.readFileSync(file.startsWith(APP_REFERENCE)?path.join(app,file.slice(APP_REFERENCE.length)):path.join(root,file),'utf8');
  for(const [value] of text.matchAll(/(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/g))if(!/^(.)\1+$/.test(value))declared.set(value,new Set([...(declared.get(value)||[]),file]));
 }
 // A submodule gitlink is a declaration too.
 for(const row of tree(root).filter(row=>row.mode==='160000'))declared.get(row.object)?.add('gitlink:'+row.file);
 assert.deepEqual([...declared].filter(([,files])=>files.size>1).map(([value,files])=>value+': '+[...files].sort().join(', ')),[]);
});
