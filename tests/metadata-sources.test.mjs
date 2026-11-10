import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {initializeMetadataSources} from '../tools/init-runtime-sources.mjs';
const root=path.resolve(import.meta.dirname,'..');
const APP_REFERENCE='app:';

// The planner describes a package from the sources `init-runtime-sources --metadata` initializes. A
// declared file inside a gitlink that step leaves uninitialized is missing when a release is planned,
// so the plan stops on the package's unresolved inputs.
test('every declared entry and pin file lies in a gitlink that the metadata sources initialize',t=>{
 // Read-only Git runs inside an initialized checkout; the planned `submodule update` calls are
 // recorded through initializeMetadataSources' result instead of run.
 const notInitialized=[];
 const run=(args,cwd)=>{
  if(args[0]==='submodule')return '';
  if(path.resolve(cwd)!==root&&!fs.existsSync(path.join(cwd,'.git'))){notInitialized.push(path.relative(root,cwd));throw Error('Source is not initialized: '+path.relative(root,cwd));}
  return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity});
 };
 let initialized;
 try{initialized=new Set(initializeMetadataSources({directory:root,run}).map(row=>row.path));}
 catch(error){if(notInitialized.length)return t.skip('The metadata sources are not initialized: '+notInitialized[0]);throw error;}
 const listed=new Map();
 const linksOf=directory=>{
  if(!listed.has(directory))listed.set(directory,run(['ls-files','--stage'],directory).split('\n').flatMap(line=>{const match=line.match(/^160000 [a-f0-9]{40} 0\t(.+)$/);return match?[match[1]]:[];}));
  return listed.get(directory);
 };
 // The first gitlink on the way to a file that the metadata step leaves uninitialized. A gitlink pin
 // itself is read from its superproject, so only the gitlinks around it must be initialized.
 const uninitialized=file=>{
  for(let current=root,remaining=file;;){
   const link=linksOf(current).find(name=>remaining===name||remaining.startsWith(name+'/'));
   if(!link||remaining===link)return null;
   const full=path.relative(root,path.join(current,link)).split(path.sep).join('/');
   if(!initialized.has(full))return full;
   current=path.join(current,link);remaining=remaining.slice(link.length+1);
  }
 };
 const failures=[];
 try{
  for(const project of readProjects(root,{resolvePins:false}).projects){
   const files=[...(project.producer?.entries||[]),...(project.producer?.recipe?[project.producer.recipe]:[]),
    ...(project.upstreams||[]).flatMap(upstream=>upstream.pin?[upstream.pin.file??upstream.pin.gitlink]:[]),
    ...(project.build?buildRecords(project):[]).flatMap(build=>(build.archives||[]).map(pin=>pin.file))];
   for(const file of new Set(files.filter(file=>typeof file==='string'&&!file.startsWith(APP_REFERENCE)))){
    const link=uninitialized(file);
    if(link)failures.push(project.id+': '+file+' lies in gitlink '+link+', which init-runtime-sources --metadata does not initialize');
   }
  }
 }
 catch(error){if(notInitialized.length)return t.skip('A metadata source is not initialized: '+notInitialized[0]);throw error;}
 assert.deepEqual(failures,[]);
});
