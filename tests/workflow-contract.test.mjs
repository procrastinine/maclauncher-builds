import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readProjects} from '../lib/projects.mjs';

const root=path.resolve(import.meta.dirname,'..');
const files=['.github/workflows','.github/actions'].flatMap(directory=>fs.readdirSync(path.join(root,directory),{recursive:true}).filter(name=>/\.ya?ml$/.test(name)).map(name=>path.join(directory,String(name))));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const gitlinks=()=>execFileSync('git',['ls-files','--stage'],{cwd:root,encoding:'utf8',maxBuffer:Infinity}).split('\n').flatMap(line=>{const match=line.match(/^160000 [a-f0-9]{40} 0\t(.+)$/);return match?[match[1]]:[];});
const links=gitlinks();
/** A tool needs prepared sources when it or anything it imports reads the app source. */
const readsSources=(file,seen=new Set())=>{
 if(seen.has(file))return false;seen.add(file);
 if(path.basename(file)==='app-source.mjs')return true;
 const text=fs.readFileSync(file,'utf8');
 return [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].some(match=>{const next=path.resolve(path.dirname(file),match[1]);return links.some(link=>next.startsWith(path.join(root,link)+path.sep))||fs.existsSync(next)&&fs.statSync(next).isFile()&&readsSources(next,seen);});
};
const usesTools=step=>[...step.matchAll(/node (tools\/[A-Za-z0-9_.-]+\.(?:mjs|cjs|js))/g)].some(match=>!match[1].endsWith('init-runtime-sources.mjs')&&readsSources(path.join(root,match[1])));

test('workflows and actions name no project, source, submodule or recipe path',()=>{
 const projects=readProjects(root,{resolvePins:false}).projects.map(project=>project.id);
 const findings=[];
 for(const file of files){
  const text=read(file);
  for(const directory of ['sources/','producers/','projects/','catalogs/','runtimes/','publisher-records/'])if(text.includes(directory))findings.push(file+' names '+directory);
  for(const link of links)if(text.includes(link))findings.push(file+' names submodule '+link);
  for(const id of projects)if(new RegExp('(^|[^A-Za-z0-9_.-])'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|[^A-Za-z0-9_-])','m').test(text))findings.push(file+' names project '+id);
  if(/git\s+submodule/.test(text))findings.push(file+' initializes submodules itself');
 }
 assert.deepEqual(findings,[]);
});

test('dependency depth is data, not numbered jobs',()=>{
 for(const file of files){
  const text=read(file);
  assert.doesNotMatch(text,/\n  (?:build|publish)\d+:/,file);
  assert.doesNotMatch(text,/\b(?:matrix|empty)\d+\b/,file);
 }
});

test('P1 regression: ERR_MODULE_NOT_FOUND package-contract.cjs; every job that runs repository tools prepares its sources through the one tool first',()=>{
 // Run 42531180192 failed because publish and index jobs lacked a source the plan used.
 for(const file of files.filter(file=>file.startsWith('.github/workflows/'))){
  const text=read(file),jobs=text.split(/\n  (?=[A-Za-z][A-Za-z0-9_-]*:\n)/).slice(1);
  for(const job of jobs){
   const body=job.split(/\n    steps:\n/)[1];if(!body)continue;
   const steps=body.split(/\n      - /);
   const first=steps.findIndex(step=>usesTools(step)||/uses: \.\/\.github\/actions\/(?:build-runtime|publish-runtime)/.test(step));
   if(first<0)continue;
   const prepared=steps.findIndex(step=>/node tools\/init-runtime-sources\.mjs|uses: \.\/\.github\/actions\/(?:build-runtime|publish-runtime)/.test(step));
   assert.ok(prepared>=0&&prepared<=first,file+' job '+job.split(':')[0]+' runs repository tools before preparing sources');
  }
 }
 for(const action of ['build-runtime','publish-runtime']){
  const text=read('.github/actions/'+action+'/action.yml'),steps=text.split(/\n    - /);
  const first=steps.findIndex(usesTools),prepared=steps.findIndex(step=>/node tools\/init-runtime-sources\.mjs/.test(step));
  assert.ok(prepared>=0&&prepared<first,action+' runs repository tools before preparing sources');
 }
});

test('the one source tool prepares exactly the declared sources for each job kind',async()=>{
 const {initializeToolSources,initializeMetadataSources,initializeCheckSources}=await import('../tools/init-runtime-sources.mjs');
 const record=JSON.parse(read('producers/package-support/app-source.json')),checks=JSON.parse(read('tests/sources.json')).sources;
 // Every path is a registered Gitlink, or lies inside one whose nested links resolve the rest.
 const run=(args,cwd)=>{
  if(args[0]!=='ls-files')return '';
  const prefix=path.relative(root,cwd).split(path.sep).join('/'),all=[...links,...record.sourceSubmodules,...checks];
  const nested=all.filter(name=>prefix&&name.startsWith(prefix+'/')).map(name=>name.slice(prefix.length+1));
  return [...new Set(prefix?nested:links)].map(name=>'160000 '+'a'.repeat(40)+' 0\t'+name).join('\n')+'\n';
 };
 const paths=result=>result.map(row=>row.path);
 assert.deepEqual(paths(initializeToolSources({directory:root,run})),[record.gitlink]);
 assert.deepEqual(paths(initializeMetadataSources({directory:root,run})),record.sourceSubmodules);
 assert.deepEqual(paths(initializeCheckSources({directory:root,run})),[...new Set([...record.sourceSubmodules,...checks])]);
 for(const name of checks)assert.ok(links.includes(name),'tests/sources.json names a registered Gitlink: '+name);
});
