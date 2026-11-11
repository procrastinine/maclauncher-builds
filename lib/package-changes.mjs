import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonicalReport} from './canonical-report.mjs';
import {readProjects,resolveProject,declaredRecipeEntries} from './projects.mjs';
import {submoduleOrigins} from './source-pins.mjs';
import {treeSource} from './tree-source.mjs';
import {APP_REFERENCE,appSourceRoot} from '../tools/app-source.mjs';

const ordinal=(a,b)=>a<b?-1:a>b?1:0;
const issue=(name,reason)=>({name,reason});

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
 const releaseRepository=readProjects(directory,{resolvePins:false}).repository;
 return fs.readdirSync(path.join(directory,'catalogs')).sort().flatMap(file=>{
  if(!file.endsWith('.json')||file==='index.json')return [];
  const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalogs',file),'utf8'));
  const grouped=Map.groupBy(catalog.packages,record=>record.version);
  const releases=[...grouped].map(([version,records])=>{
   const revisions=records.map(record=>{
    if(record.build?.sourceRevision)return record.build.sourceRevision;
    const repository=record.source?.repository?.replace(/^https:\/\/github.com\//,'').replace(/\.git$/,'');
    return record.source?.revision&&repository===releaseRepository?record.source.revision:null;
   });
   const conflicting=new Set(revisions).size!==1;
   const unrecordedInputs=conflicting?[issue('sourceRevision',
    'Architecture records name different Builds commits: '+records.map((record,i)=>
     record.arch+'='+revisions[i]).sort().join(', '))]:[];
   return {version,architectures:[...new Set(records.map(record=>record.arch))].sort(),
    sourceRevision:conflicting?null:revisions[0],...(unrecordedInputs.length?{unrecordedInputs}:{})};
  });
  return [{projectId:catalog.projectId,releases}];
 }).sort((a,b)=>ordinal(a.projectId,b.projectId));
}

/** Declared files supply both Builds paths and the consumed paths within each Gitlink. */
function recipeScopes(project,source){
 const manifest=source.json('projects.json');
 const registries=new Set(['projects.json',...Object.values(manifest.registries||{})]);
 const entries=declaredRecipeEntries(project,manifest);
 for(const upstream of project.upstreams)entries.push(upstream.pin?.file||upstream.pin?.gitlink);
 const builds=Array.isArray(project.build)?project.build:project.build?[project.build]:[];
 const initialized=builds.flatMap(build=>build.submodules||[]);
 const paths=new Set(),scopes=new Map();
 const addSource=(link,inner)=>{
  if(!scopes.has(link))scopes.set(link,new Set());
  if(inner)scopes.get(link).add(inner);
 };
 for(const entry of entries.filter(Boolean)){
  if(registries.has(entry))continue;
  if(entry.startsWith(APP_REFERENCE)){
   const app=appSourceRoot(source.root,{source});
   const link=path.relative(source.root,app.directory);
   paths.add(link);addSource(link,entry.slice(APP_REFERENCE.length));
  }else{
   const owning=source.owningPath(entry);
   paths.add(owning);
   if(source.gitlinks().has(owning))addSource(owning,entry===owning?null:entry.slice(owning.length+1));
  }
 }
 for(const entry of initialized){
  const owning=source.owningPath(entry);
  paths.add(owning);addSource(owning,null);
 }
 const origins=scopes.size?submoduleOrigins(source.root,source):new Map();
 const repositories=[...scopes].sort(([a],[b])=>ordinal(a,b)).map(([link,consumed])=>({
  link,repository:origins.get(link),paths:consumed.size?[...consumed].sort():['.'],
  revision:source.revision({gitlink:link})
 }));
 return {paths:[...paths].sort(),repositories};
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
   catch(error){unrecordedInputs.push(issue('gitlink:'+name,error.message));}
  }
  let scopes={paths:[],repositories:[]};
  try{scopes=recipeScopes(declared,source);}
  catch{unrecordedInputs.push(issue('recipePaths','Recorded recipe paths are unavailable.'));}
  return {...scopes,inputs,notes:builds.find(build=>build.version===version)?.notes,unrecordedInputs};
 }catch{
  return {inputs:new Map(),paths:[],repositories:[],
   unrecordedInputs:[issue(id,'Recorded project data is unavailable or unsupported.')]};
 }
}

export function diffInputs(before,after){
 const names=[...new Set([...before.keys(),...after.keys()])].sort();
 return names.flatMap(name=>{
  const previous=before.get(name)||null,current=after.get(name)||null;
  return canonicalReport(previous)===canonicalReport(current)?[]:[{name,before:previous,after:current}];
 });
}

/** A shallow boundary inside the requested range is incomplete history, not a partial changelog. */
export function recipeCommits(directory,before,after,paths,unrecordedInputs=[],name='recipeCommits'){
 if(!before||!after||before===after||!paths.length)return [];
 try{
  git(directory,['cat-file','-e',before+'^{commit}']);
  git(directory,['cat-file','-e',after+'^{commit}']);
  const range=before+'..'+after;
  const shallow=path.resolve(directory,git(directory,['rev-parse','--git-path','shallow']));
  if(fs.existsSync(shallow)){
   const boundaries=new Set(fs.readFileSync(shallow,'utf8').trim().split('\n'));
   if(git(directory,['rev-list',range]).split('\n').some(revision=>boundaries.has(revision))){
    throw Error('Shallow boundary');
   }
  }
  return git(directory,['log','--format=%H%x09%cI%x09%s',range,'--',...paths])
   .split('\n').filter(Boolean).map(line=>{
    const [revision,date,...subject]=line.split('\t');
    return {revision,date,subject:subject.join('\t')};
   }).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)||ordinal(a.revision,b.revision));
 }catch{
  unrecordedInputs.push(issue(name,'Commit history is unavailable for '+before+'..'+after+'.'));
  return [];
 }
}

function sourceCommits(directory,before,after,unrecordedInputs){
 const previous=new Map(before.map(repository=>[repository.link,repository]));
 return after.flatMap(repository=>{
  const prior=previous.get(repository.link);
  if(!prior||prior.revision===repository.revision)return [];
  const paths=[...new Set([...prior.paths,...repository.paths])].sort();
  const commits=recipeCommits(path.join(directory,repository.link),prior.revision,repository.revision,
   paths,unrecordedInputs,'commits:gitlink:'+repository.link);
  return commits.map(commit=>({...commit,repository:repository.repository}));
 });
}

export function packageChanges({directory}){
 const sources=new Map(),dates=new Map();
 const source=revision=>{
  if(!sources.has(revision))sources.set(revision,treeSource(directory,{at:revision}));
  return sources.get(revision);
 };
 const date=revision=>{
  if(!revision)return null;
  if(!dates.has(revision)){
   try{dates.set(revision,Date.parse(git(directory,['show','-s','--format=%cI',revision])));}
   catch{dates.set(revision,null);}
  }
  return dates.get(revision);
 };
 const projects=publishedVersions(directory).map(project=>{
  const versions=project.releases.sort((a,b)=>{
   const left=date(a.sourceRevision),right=date(b.sourceRevision);
   return (left!==null&&right!==null?left-right:0)||compareVersions(a.version,b.version);
  });
  let previous=null,prior={inputs:new Map(),paths:[],repositories:[]};
  const releases=versions.map(release=>{
   const unrecordedInputs=[...(release.unrecordedInputs||[])];
   if(!release.sourceRevision&&!unrecordedInputs.length){
    unrecordedInputs.push(issue('sourceRevision','Catalog has no Builds source revision.'));
   }else if(release.sourceRevision&&date(release.sourceRevision)===null){
    unrecordedInputs.push(issue('sourceRevision','Recorded Builds commit is unavailable: '+release.sourceRevision));
   }
   const current=release.sourceRevision?inputsAtCommit(project.projectId,release.version,source(release.sourceRevision))
    :{inputs:new Map(),paths:[],repositories:[],unrecordedInputs:[]};
   unrecordedInputs.push(...current.unrecordedInputs);
   const paths=[...new Set([...prior.paths,...current.paths])].sort();
   const commits=[...recipeCommits(directory,previous?.sourceRevision,release.sourceRevision,paths,unrecordedInputs),
    ...sourceCommits(directory,prior.repositories,current.repositories,unrecordedInputs)];
   commits.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)||
    ordinal(a.repository||'',b.repository||'')||ordinal(a.revision,b.revision));
   const entry={...release,previousVersion:previous?.version||null,
    inputs:diffInputs(prior.inputs,current.inputs),commits,
    ...(current.notes?{notes:current.notes}:{}),
    ...(unrecordedInputs.length?{unrecordedInputs:unrecordedInputs.sort((a,b)=>ordinal(a.name,b.name))}:{})};
   previous=release;prior=current;
   return entry;
  });
  return {projectId:project.projectId,releases};
 });
 return {schemaVersion:1,projects};
}
