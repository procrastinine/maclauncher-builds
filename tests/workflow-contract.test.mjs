import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readProjects} from '../lib/projects.mjs';

// Cleanliness: workflows and actions are generic. P1 (run 42531180192): every job prepares its sources before any tool runs.
test('workflows and actions name no project, source or path, have no numbered levels, and prepare sources first',()=>{
 const root=path.resolve(import.meta.dirname,'..'),files=['workflows','actions'].flatMap(dir=>fs.readdirSync(path.join(root,'.github',dir),{recursive:true}).filter(name=>/\.yml$/.test(name)).map(name=>path.join(root,'.github',dir,name)));
 const links=execFileSync('git',['ls-files','--stage'],{cwd:root,encoding:'utf8',maxBuffer:Infinity}).split('\n').flatMap(line=>line.match(/^160000 \S+ 0\t(.+)$/)?.slice(1)||[]);
 const names=[...links,...readProjects(root,{resolvePins:false}).projects.map(project=>project.id)],found=[];
 for(const file of files){
  const text=fs.readFileSync(file,'utf8'),label=path.relative(root,file);
  for(const name of names)if(new RegExp('(^|[^\\w.-])'+name.replace(/[.+]/g,'\\$&')+'($|[^\\w-])','m').test(text))found.push(label+' names '+name);
  for(const pattern of [/(?:sources|producers|projects|catalogs)\//,/git\s+submodule/,/\n  (?:build|publish)\d+:|\b(?:matrix|empty)\d+\b/])if(pattern.test(text))found.push(label+' matches '+pattern);
  for(const steps of text.split(/\n\s+steps:\n/).slice(1).map(body=>body.split(/\n {4,6}- /))){
   const first=steps.findIndex(step=>/node tools\/|actions\/(?:build|publish)-runtime/.test(step));
   if(first>=0&&!/node tools\/init-runtime-sources\.mjs|actions\/(?:build|publish)-runtime/.test(steps[first]))found.push(label+' runs a tool before preparing sources');
  }
 }
 assert.deepEqual(found,[]);
});
