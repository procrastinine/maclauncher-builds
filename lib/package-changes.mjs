import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonicalReport} from './canonical-report.mjs';
import {readProjects,resolveProject,declaredRecipeEntries} from './projects.mjs';
import {treeSource} from './tree-source.mjs';
import {APP_REFERENCE,appSourceRoot} from '../tools/app-source.mjs';

const ordinal=(a,b)=>a<b?-1:a>b?1:0;

function git(directory,args){
 return execFileSync('git',['-C',directory,...args],{
  encoding:'utf8',maxBuffer:1<<26,stdio:['ignore','pipe','pipe']
 }).trim();
}

function compareVersions(a,b){
 const left=a.match(/\d+|\D+/g)||[],right=b.match(/\d+|\D+/g)||[];
 for(let i=0;i<Math.min(left.length,right.length);i++){
  const numeric=/^\d+$/.test(left[i])&&/^\d+$/.test(right[i]);
  const result=numeric?ordinal(BigInt(left[i]),BigInt(right[i])):ordinal(left[i],right[i]);
  if(result)return result;
 }
 return ordinal(left.length,right.length);
}

/** Catalogs alone determine published project and version identities. */
export function publishedVersions(directory){
 const repository=readProjects(directory,{resolvePins:false}).repository;
 return fs.readdirSync(path.join(directory,'catalogs')).sort().flatMap(file=>{
  if(!file.endsWith('.json')||file==='index.json')return [];
  const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalogs',file),'utf8'));
  const grouped=Map.groupBy(catalog.packages,record=>record.version);
  const releases=[...grouped].map(([version,records])=>{
   const releaseRepository=repository;
   const revisions=records.map(record=>{
    if(record.build?.sourceRevision)return record.build.sourceRevision;
    const repository=record.source?.repository?.replace(/^https:\/\/github.com\//,'').replace(/\.git$/,'');
    if(record.source?.revision&&repository===releaseRepository)return record.source.revision;
    return null;
   });
   if(new Set(revisions).size!==1){
    throw Error('Conflicting architecture source revisions: '+catalog.projectId+' '+version);
   }
   return {version,architectures:[...new Set(records.map(record=>record.arch))].sort(),
    sourceRevision:revisions[0]};
  });
  return [{projectId:catalog.projectId,releases}];
 }).sort((a,b)=>ordinal(a.projectId,b.projectId));
}

function recipePaths(project,source){
 const manifest=source.json('projects.json');
 const entries=declaredRecipeEntries(project,manifest);
 for(const upstream of project.upstreams)entries.push(upstream.pin?.file||upstream.pin?.gitlink);
 const builds=Array.isArray(project.build)?project.build:project.build?[project.build]:[];
 for(const build of builds)entries.push(...(build.submodules||[]));
 const paths=entries.filter(Boolean).map(entry=>{
  if(entry.startsWith(APP_REFERENCE))return path.relative(source.root,appSourceRoot(source.root,{source}).directory);
  return source.owningPath(entry);
 });
 return [...new Set(paths)].sort();
}

/** The regular project resolver reads historical data; unsupported records stay explicit. */
export function inputsAtCommit(id,version,source){
 const options={directory:source.root,source,allowUnrecordedInputs:true};
 try{
  const declared=resolveProject(id,{...options,resolvePins:false});
  const project=resolveProject(id,options);
  const inputs=new Map(project.upstreams.map(upstream=>{
   const value={repository:upstream.url};
   for(const key of ['revision','version'])if(upstream[key]!==undefined)value[key]=upstream[key];
   return [upstream.id,value];
  }));
  const unrecordedInputs=[...(project.unrecordedInputs||[])];
  const builds=Array.isArray(project.build)?project.build:project.build?[project.build]:[];
  const submodules=builds.flatMap(build=>build.submodules||[]).map(name=>source.owningPath(name));
  for(const name of new Set(submodules)){
   try{inputs.set('gitlink:'+name,{revision:source.revision({gitlink:name})});}
   catch(error){unrecordedInputs.push({name:'gitlink:'+name,reason:error.message});}
  }
  return {
   inputs,paths:recipePaths(declared,source),
   notes:builds.find(build=>build.version===version)?.notes,
   unrecordedInputs:unrecordedInputs.sort((a,b)=>ordinal(a.name,b.name))
  };
 }catch(error){
  return {inputs:new Map(),paths:[],unrecordedInputs:[{name:id,reason:error.message}]};
 }
}

export function diffInputs(before,after){
 const names=[...new Set([...before.keys(),...after.keys()])].sort();
 return names.flatMap(name=>{
  const previous=before.get(name)||null,current=after.get(name)||null;
  return canonicalReport(previous)===canonicalReport(current)?[]:[{name,before:previous,after:current}];
 });
}

export function recipeCommits(directory,before,after,paths){
 if(!before||!paths.length)return [];
 const output=git(directory,['log','--format=%H%x09%cI%x09%s',before+'..'+after,'--',...paths]);
 return output.split('\n').filter(Boolean).map(line=>{
  const [revision,date,...subject]=line.split('\t');
  return {revision,date,subject:subject.join('\t')};
 }).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)||ordinal(a.revision,b.revision));
}

export function packageChanges({directory}){
 const sources=new Map(),dates=new Map();
 const source=revision=>{
  if(!sources.has(revision))sources.set(revision,treeSource(directory,{at:revision}));
  return sources.get(revision);
 };
 const date=revision=>{
  if(!revision)return -Infinity;
  if(!dates.has(revision))dates.set(revision,git(directory,['show','-s','--format=%cI',revision]));
  return Date.parse(dates.get(revision));
 };
 const projects=publishedVersions(directory).map(project=>{
  const versions=project.releases.sort((a,b)=>
   date(a.sourceRevision)-date(b.sourceRevision)||compareVersions(a.version,b.version));
  let previous=null,prior={inputs:new Map(),paths:[]};
  const releases=versions.map(release=>{
   const current=release.sourceRevision
    ?inputsAtCommit(project.projectId,release.version,source(release.sourceRevision))
    :{inputs:new Map(),paths:[],unrecordedInputs:[{name:project.projectId,reason:'Catalog has no Builds source revision.'}]};
   const paths=[...new Set([...prior.paths,...current.paths])].sort();
   const entry={...release,previousVersion:previous?.version||null,
    inputs:diffInputs(prior.inputs,current.inputs),
    commits:recipeCommits(directory,previous?.sourceRevision,release.sourceRevision,paths),
    ...(current.notes?{notes:current.notes}:{}),
    ...(current.unrecordedInputs.length?{unrecordedInputs:current.unrecordedInputs}:{})};
   previous=release;prior=current;
   return entry;
  });
  return {projectId:project.projectId,releases};
 });
 return {schemaVersion:1,projects};
}
