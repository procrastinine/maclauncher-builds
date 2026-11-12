import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {initializeSources} from '../tools/init-runtime-sources.mjs';
import {recipeBuildReport} from '../tools/recipe-build-report.mjs';

const root=path.resolve(import.meta.dirname,'..');

test('AnyPS5 declares, initializes and materializes every separately pinned dependency',()=>{
 const dependencies=JSON.parse(fs.readFileSync(path.join(root,'producers/anyps5/dependencies.json')));
 const paths=[...new Set(dependencies.dependencies.map(entry=>entry.sourcePath).filter(Boolean))];
 assert.ok(paths.length,'The input check must cover a separately pinned dependency.');
 const project=readProjects(root,{resolvePins:false}).projects.find(row=>row.id==='anyps5');
 for(const build of buildRecords(project)){
  for(const source of paths)assert.ok(build.submodules.includes(source),'AnyPS5 must declare '+source);
  const calls=[];
  const result=initializeSources({project:'anyps5',version:build.version,directory:root,run:(args,cwd)=>{
   calls.push({args,cwd});
   return args[0]==='ls-files'?execFileSync('git',args,{cwd,encoding:'utf8'}):'';
  }});
  for(const source of paths){
   assert.ok(result.initialized.some(row=>row.path===source),'AnyPS5 must initialize '+source);
   assert.ok(calls.some(({args,cwd})=>cwd===root&&args[0]==='submodule'&&args.includes('--init')&&args.slice(args.indexOf('--')+1).includes(source)),'The source step must request '+source);
  }
 }
 const {definition}=recipeBuildReport({id:'anyps5',directory:root});
 for(const source of paths)assert.ok(definition.gitlinks.some(row=>row.path===source),'The materialized definition must contain '+source);
});
