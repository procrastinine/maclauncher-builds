import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {initializeMetadataSources} from '../tools/init-runtime-sources.mjs';
const root=path.resolve(import.meta.dirname,'..');
const APP_REFERENCE='app:';
const json=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));

// The planner (tools/recipe-build-report.mjs) describes a package from the sources that
// `init-runtime-sources --metadata` initializes. It reads every pin's file, including a file inside a
// gitlink checkout, and the records of tracked JSON files with the pins nested in them. A pin whose
// file lies inside a gitlink that the metadata step leaves uninitialized is missing when a release is
// planned, so the plan stops on the package's unresolved inputs.
test('every pin the planner reads lies in a gitlink that the metadata sources initialize',t=>{
 // Read-only Git runs inside an initialized checkout; the planned `submodule update` calls are
 // recorded through initializeMetadataSources' result instead of run.
 const notInitialized=[];
 const run=(args,cwd)=>{
  if(args[0]==='submodule')return '';
  if(path.resolve(cwd)!==root&&!fs.existsSync(path.join(cwd,'.git'))){notInitialized.push(path.relative(root,cwd));throw Error('Source is not initialized: '+path.relative(root,cwd));}
  return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity});
 };
 const skip=error=>{if(notInitialized.length)return t.skip('A metadata source is not initialized: '+notInitialized[0]);throw error;};
 let initialized;
 try{initialized=new Set(initializeMetadataSources({directory:root,run}).map(row=>row.path));}catch(error){return skip(error);}
 const listed=new Map(),tracked=new Set();
 const linksOf=directory=>{
  if(!listed.has(directory))listed.set(directory,run(['ls-files','--stage'],directory).split('\n').flatMap(line=>{
   const match=line.match(/^(\d+) [a-f0-9]{40} 0\t(.+)$/);if(!match)return [];
   if(match[1]!=='160000'){if(directory===root)tracked.add(match[2]);return [];}
   return [match[2]];
  }));
  return listed.get(directory);
 };
 const topLinks=linksOf(root),inLink=file=>topLinks.some(link=>file===link||file.startsWith(link+'/'));
 // The first gitlink around a file (or around a gitlink, for a gitlink pin) that the metadata step
 // leaves uninitialized.
 const uninitialized=file=>{
  for(let current=root,remaining=file;;){
   const link=linksOf(current).find(name=>remaining===name||remaining.startsWith(name+'/'));
   if(!link||remaining===link)return null;
   const full=path.relative(root,path.join(current,link)).split(path.sep).join('/');
   if(!initialized.has(full))return full;
   current=path.join(current,link);remaining=remaining.slice(link.length+1);
  }
 };
 const manifest=json('projects.json'),registryFiles=new Set(['projects.json',...Object.values(manifest.registries||{})]);
 // A record is a tracked JSON file outside every gitlink, as the planner's addFile reads it.
 const isRecord=file=>file.endsWith('.json')&&tracked.has(file)&&!registryFiles.has(file)&&!file.startsWith('catalogs/');
 // The pins and gitlink source records nested in one record, each resolved once: a nested pin's file
 // is the first candidate from the record's directory upward that exists when the plan runs.
 const resolved=new Map();
 const nestedPins=record=>{
  if(resolved.has(record))return resolved.get(record);
  const result={records:[],failures:[]},pins=[];
  const walk=value=>{
   if(Array.isArray(value)){value.forEach(walk);return;}
   if(!value||typeof value!=='object')return;
   if(typeof value.gitlink==='string')pins.push({gitlink:value.gitlink});
   if(typeof value.file==='string'&&(typeof value.pointer==='string'||value.keys))pins.push({file:value.file});
   Object.values(value).forEach(walk);
  };
  walk(json(record));
  for(const pin of pins){
   if(pin.gitlink!==undefined){const link=uninitialized(pin.gitlink);if(link)result.failures.push(record+' names gitlink '+pin.gitlink+' inside gitlink '+link);continue;}
   if(pin.file.startsWith(APP_REFERENCE))continue;
   const candidates=[];for(let directory=path.posix.dirname(record);;directory=path.posix.dirname(directory)){candidates.push(path.posix.normalize(path.posix.join(directory,pin.file)));if(directory==='.')break;}
   for(const candidate of candidates.filter(candidate=>!candidate.startsWith('../'))){
    if(tracked.has(candidate)){if(isRecord(candidate))result.records.push(candidate);break;}
    if(!inLink(candidate))continue;
    const link=uninitialized(candidate);
    if(link){result.failures.push(record+' pins '+pin.file+', which lies in gitlink '+link);break;}
    if(fs.statSync(path.join(root,candidate),{throwIfNoEntry:false})?.isFile())break;
   }
  }
  resolved.set(record,result);return result;
 };
 const failures=[];
 try{
  for(const project of readProjects(root,{resolvePins:false}).projects){
   const problems=new Set(),queue=[];
   // Declared entries and the build code are read as records when they are tracked JSON files.
   for(const name of [...(manifest.buildCode||[]),...(project.producer?.entries||[]),...(project.producer?.recipe?[project.producer.recipe]:[])]){
    if(typeof name!=='string'||name.startsWith(APP_REFERENCE)||inLink(name))continue;
    if(tracked.has(name))queue.push(name);else for(const file of tracked)if(file.startsWith(name+'/'))queue.push(file);
   }
   // A registry pin names its file from the repository root.
   const pins=[...(project.upstreams||[]).flatMap(upstream=>upstream.pin?[upstream.pin]:[]),...(project.build?buildRecords(project):[]).flatMap(build=>build.archives||[])];
   for(const pin of pins){
    const file=pin.file??pin.gitlink;if(typeof file!=='string'||file.startsWith(APP_REFERENCE))continue;
    const link=uninitialized(file);
    if(link)problems.add('projects.json pins '+file+', which lies in gitlink '+link);
    else if(pin.file!==undefined)queue.push(pin.file);
   }
   for(const seen=new Set();queue.length;){
    const record=queue.shift();if(seen.has(record)||!isRecord(record))continue;seen.add(record);
    const {records,failures:found}=nestedPins(record);found.forEach(problem=>problems.add(problem));queue.push(...records);
   }
   for(const problem of problems)failures.push(project.id+': '+problem+', which init-runtime-sources --metadata does not initialize');
  }
 }
 catch(error){return skip(error);}
 assert.deepEqual(failures,[]);
});
