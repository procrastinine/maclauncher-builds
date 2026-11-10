import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';
const root=path.resolve(import.meta.dirname,'..');

// The calls that point a compile at a lock cache with no network access. tools/build-locks.mjs defines
// the caches and tools/rust-build.mjs defines rustEnvironment; both are build code that every
// definition holds, so only their callers count. Every build has the Rust toolchain and nxnative
// carries its own .NET SDK, while Go runs only in a build that declares the go tool, so a recipe file
// shared with a package that never runs Go does not make that package a Go build.
const OFFLINE={
 cargo:{call:/\brustEnvironment\(|LOCKED_ENVIRONMENT\.cargo\(/,runs:()=>true},
 go:{call:/LOCKED_ENVIRONMENT\.go\(/,runs:build=>(build.tools||[]).includes('go')},
 nuget:{call:/LOCKED_ENVIRONMENT\.nuget\(|lockCache\(['"]nuget['"]\)/,runs:()=>true}
};
const DEFINITIONS=new Set(['tools/build-locks.mjs','tools/rust-build.mjs']);

// A compile that reads a tool's lock cache offline finds only what build-runtime --prepare fetched for
// the build's declared locks, so a package without a lock for that tool fails at compile on GitHub.
test('a package whose build code compiles offline from a lock cache declares a lock for that tool',async t=>{
 const describe=createRecipeBuildReporter({directory:root}),texts=new Map(),failures=[];
 const text=file=>{
  if(!texts.has(file))texts.set(file,/\.(mjs|cjs|js)$/.test(file)&&!DEFINITIONS.has(file)?fs.readFileSync(path.join(root,file),'utf8'):'');
  return texts.get(file);
 };
 for(const project of readProjects(root,{resolvePins:false}).projects){
  if(!project.build)continue;
  // The definitions read the initialized sources, which the Source workflow prepares with --checks.
  let report;try{report=await describe(project.id);}
  catch(error){if(error.code==='ENOENT'&&String(error.path).startsWith(path.join(root,'sources')+path.sep))return t.skip('A source the definitions read is not initialized: '+path.relative(root,error.path));throw error;}
  const files=(report.definition.files||[]).map(row=>row.path).filter(file=>!file.startsWith('app:'));
  const builds=buildRecords(project),declared=new Set(builds.flatMap(build=>(build.locks||[]).map(lock=>lock.tool)));
  for(const [tool,{call,runs}] of Object.entries(OFFLINE)){
   if(declared.has(tool)||!builds.some(runs))continue;
   const callers=files.filter(file=>call.test(text(file)));
   if(callers.length)failures.push(project.id+': '+callers.join(', ')+' compiles offline from the '+tool+' lock cache, and the build declares no '+tool+' lock');
  }
 }
 assert.deepEqual(failures,[]);
});
