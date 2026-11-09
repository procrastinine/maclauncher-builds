import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {resolveUpstream,validatePinReference} from "../lib/source-pins.mjs";
import {sourceRecordProblem} from '../lib/pins.mjs';
import {APP_REFERENCE,appSourceRoot} from './app-source.mjs';
import {canonicalReport,reportDigest} from '../lib/canonical-report.mjs';
export {canonicalReport,reportDigest};
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const posix=name=>path.posix.normalize(String(name)).replace(/\/+$/,'');
const parsePointer=pointer=>pointer.slice(1).split('/').map(key=>key.replaceAll('~1','/').replaceAll('~0','~'));
function slot(value,pointer){const keys=parsePointer(pointer),key=keys.pop();for(const part of keys){if(!value||!Object.hasOwn(value,part))return null;value=value[part];}return value&&Object.hasOwn(value,key)?{value,key}:null;}
/** Locale-independent string order, so the build definition and its digest match on every runner. */
const ordinal=(a,b)=>a<b?-1:a>b?1:0;
function normalizedBuilds(builds){
 const commands=new Map();for(const {version,...build} of builds){let combined=commands.get(build.command);if(!combined){combined={command:build.command};commands.set(build.command,combined);}for(const [key,value] of Object.entries(build)){if(key==='command')continue;if(Array.isArray(value))combined[key]=[...new Set([...(combined[key]||[]),...value])].sort();else if(value&&typeof value==='object')combined[key]={...combined[key],...value};else if(typeof value==='boolean')combined[key]=!!(combined[key]||value);else combined[key]=value;}}
 return [...commands.values()].sort((a,b)=>ordinal(a.command,b.command));
}

/** Resolve each package's declared inputs into its build definition. Inputs are
 * data: the registry's shared build code, and the project's build command,
 * producer entries, app entries, submodules, package inputs and upstream pins,
 * plus the pins and package references inside the declared JSON records. Code
 * is never read for discovery. This is the one validation of records and pins.
 */
export function createRecipeBuildReporter({directory=path.resolve(import.meta.dirname,'..')}={}){
 const root=fs.realpathSync(directory),registry=readProjects(root,{resolvePins:false}),projects=new Map(registry.projects.map(project=>[project.id,project])),cache=new Map(),problems=new Map();
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'projects.json'))),registryFiles=new Set(['projects.json',...Object.values(manifest.registries||{})]);
 const bindings=new Map();for(const project of projects.values())for(const binding of project.versionBindings||[]){if(!bindings.has(binding.file))bindings.set(binding.file,[]);bindings.get(binding.file).push(binding);}
 let gitlinks=[],trackedFiles=null;
 try{trackedFiles=[];gitlinks=execFileSync('git',['ls-files','--stage'],{cwd:root,encoding:'utf8',maxBuffer:Infinity,stdio:['ignore','pipe','ignore']}).split('\n').flatMap(line=>{const match=/^(\d+) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);if(!match)return [];if(match[1]!=='160000'){trackedFiles.push(match[3]);return [];}return [{path:match[3],revision:match[2]}];});}catch{trackedFiles=null;/* Non-Git recipe fixtures declare files on disk and no Gitlinks. */}
 const tracked=trackedFiles&&new Set(trackedFiles);
 const isFile=relative=>tracked?tracked.has(relative):fs.statSync(path.join(root,relative),{throwIfNoEntry:false})?.isFile()===true;
 const filesBelow=relative=>trackedFiles?trackedFiles.filter(file=>file.startsWith(relative+'/')):fs.statSync(path.join(root,relative),{throwIfNoEntry:false})?.isDirectory()?fs.readdirSync(path.join(root,relative),{recursive:true}).map(name=>path.posix.join(relative,name.split(path.sep).join('/'))).filter(file=>fs.statSync(path.join(root,file)).isFile()):[];
 const linkOf=relative=>gitlinks.find(link=>relative===link.path||relative.startsWith(link.path+'/'))??null;
 // The pinned app checkout is read in place, as tools/app-source.mjs reads it.
 const appSource=fs.existsSync(path.join(root,'producers/package-support/app-source.json'))?appSourceRoot(root):null;
 // Every build initializes the declared source metadata checkouts as well as its own submodules.
 const metadata=appSource?JSON.parse(fs.readFileSync(path.join(root,"producers/package-support/app-source.json"))).sourceSubmodules||[]:[];
 const appTracked=appSource?execFileSync('git',['-C',appSource.directory,'ls-files','-z'],{encoding:'utf8',maxBuffer:Infinity}).split('\0').filter(Boolean):[],appSet=new Set(appTracked);
 const bytesOf=new Map(),read=absolute=>{if(!bytesOf.has(absolute))bytesOf.set(absolute,fs.readFileSync(absolute));return bytesOf.get(absolute);};
 function normalizedJson(file,value){
  value=structuredClone(value);
  for(const binding of bindings.get(file)||[]){const target=slot(value,binding.pointer);if(!target)continue;
   if(!binding.select)target.value[target.key]='$packageVersion';
   else if(Array.isArray(target.value[target.key])){const rows=target.value[target.key],matches=row=>Object.entries(binding.select).every(([key,expected])=>expected==='$version'||row?.[key]===expected);for(const row of rows)if(matches(row)&&Object.hasOwn(row,'version'))row.version='$packageVersion';if(binding.select.version==='$version'){const unique=new Map(rows.map(row=>[canonicalReport(row),row]));target.value[target.key]=[...unique.values()];}}
  }
  return value;
 }
 function describe(id){
  if(cache.has(id))return cache.get(id);
  const project=projects.get(id);if(!project)throw Error('Unknown recipe project: '+id);
  const builds=project.build?buildRecords(project):[],files=new Map(),appFiles=new Map(),usedLinks=new Map(),inputs=new Set(),unresolved=[],records=[];
  const submodules=new Set(builds.flatMap(build=>build.submodules||[])),initialized=[...submodules,...metadata];
  const problem=(file,expression,reason,detail)=>unresolved.push({file,expression,reason,...(detail?{problem:detail}:{})});
  // A pin reads only the commit a Gitlink records; a file inside a Gitlink needs its checkout, which the build initializes only when declared.
  const useLink=(relative,from,checkout=false)=>{const link=linkOf(relative);if(!link)return null;usedLinks.set(link.path,link);if(checkout&&!initialized.some(name=>name===relative||relative.startsWith(name+"/")||name.startsWith(relative+"/")))problem(from,relative,"submodule","The build reads files of a Gitlink checkout its build record does not declare.");return link;};
  const addFile=(relative,from)=>{
   if(files.has(relative)||registryFiles.has(relative)||relative.startsWith('catalogs/'))return;
   const bytes=read(path.join(root,relative));
   if(relative.endsWith('.json')){const raw=JSON.parse(bytes);files.set(relative,reportDigest(normalizedJson(relative,raw)));records.push([relative,raw]);}
   else files.set(relative,sha256(bytes));
  };
  const addApp=(relative,from)=>{if(appFiles.has(relative))return;const bytes=read(path.join(appSource.directory,relative));appFiles.set(relative,sha256(bytes));if(relative.endsWith('.json'))records.push([APP_REFERENCE+relative,JSON.parse(bytes)]);};
  // A declared entry is a tracked file, or a directory declaring every tracked file below it.
  function entry(name,from){
   if(typeof name!=='string'||!name){problem(from,String(name),'missing');return;}
   if(name.startsWith(APP_REFERENCE)){appEntry(name.slice(APP_REFERENCE.length),from);return;}
   const relative=posix(name);
   if(useLink(relative,from,true))return;
   if(isFile(relative)){addFile(relative,from);return;}
   const below=filesBelow(relative);
   if(!below.length){problem(from,name,"missing");return;}
   for(const file of below)if(!linkOf(file))addFile(file,from);
  }
  function appEntry(name,from){
   const relative=posix(name);
   if(!appSource||!relative||relative==='.'||relative.startsWith('../')||relative.startsWith('/')){problem(from,APP_REFERENCE+name,'missing');return;}
   if(appSet.has(relative)){addApp(relative,from);return;}
   const below=appTracked.filter(file=>file.startsWith(relative+'/'));
   if(below.length)for(const file of below)addApp(file,from);
   else problem(from,APP_REFERENCE+name,'missing');
  }
  for(const name of manifest.buildCode||[])entry(name,'projects.json');
  for(const build of builds){entry(build.command,'projects');for(const name of submodules)if(!useLink(name,"projects"))problem('projects',name,'missing');
   for(const input of build.inputs||[])if(projects.has(input)&&input!==id)inputs.add(input);else problem('projects',input,'input','A package input names another registered project.');}
  for(const name of project.producer.entries||[])entry(name,'projects');
  for(const name of project.producer.appEntries||[])entry(APP_REFERENCE+name,'projects');
  if(project.producer.recipe)entry(project.producer.recipe,'projects');
  for(const upstream of project.upstreams)if(upstream.pin){
   const expression=JSON.stringify(upstream.pin);
   try{validatePinReference(upstream.pin);}catch(error){problem("projects",expression,"pin",error.message);continue;}
   if(["revision","version","committedAt"].some(key=>Object.hasOwn(upstream,key)))problem("projects",expression,"pin","A referenced source pin cannot also declare a revision, version or timestamp override.");
   if(upstream.pin.gitlink)useLink(upstream.pin.gitlink,"projects");else checkPin(upstream.pin,"projects.json");
  }
  // A pin names a JSON record by file and pointer; a relative file is resolved
  // from the declaring JSON file's directory or one of its parents.
  function checkPin(pin,from){
   const expression=JSON.stringify(pin);let selected;
   if(pin.file.startsWith(APP_REFERENCE)){const relative=pin.file.slice(APP_REFERENCE.length);if(!appSet.has(relative)){problem(from,expression,'missing');return;}addApp(relative,from);selected=JSON.parse(read(path.join(appSource.directory,relative)));}
   else{
    const candidates=[];if(from.startsWith(APP_REFERENCE)||from==='projects.json')candidates.push(posix(pin.file));else for(let directory=path.posix.dirname(from);;directory=path.posix.dirname(directory)){candidates.push(posix(path.posix.join(directory,pin.file)));if(directory==='.')break;}
    // A record inside a Gitlink checkout is pinned by that Gitlink and read from the initialized checkout.
    const inCheckout=candidate=>linkOf(candidate)&&fs.statSync(path.join(root,candidate),{throwIfNoEntry:false})?.isFile();
    const file=candidates.find(candidate=>!candidate.startsWith("../")&&(isFile(candidate)||inCheckout(candidate)));
    if(!file){problem(from,expression,"missing");return;}
    if(useLink(file,from,true)){if(!file.endsWith(".json"))return;}else{addFile(file,from);if(!file.endsWith(".json"))return;}
    selected=JSON.parse(read(path.join(root,file)));
   }
   if(pin.match)return;
   for(const key of pin.pointer?parsePointer(pin.pointer):[]){if(!selected||typeof selected!=="object"||!Object.hasOwn(selected,key)){problem(from,expression,"pin");return;}selected=selected[key];}
   if(selected&&typeof selected==="object"&&["commit","revision","gitlink"].some(key=>Object.hasOwn(selected,key))){const detail=sourceRecordProblem(selected);if(detail)problem(from,expression,'record',detail);}
  }
  // Declared records: source records are validated once here, pins add the
  // records they name, and {project} names a package input.
  function walk(value,from,pointer=''){
   if(Array.isArray(value)){value.forEach((child,index)=>walk(child,from,pointer+'/'+index));return;}
   if(!value||typeof value!=='object')return;
   if(Object.hasOwn(value,'commit')||Object.hasOwn(value,'gitlink')||typeof value.revision==='string'){
    const detail=sourceRecordProblem(value);
    if(detail)problem(from,pointer||'/',  'record',detail);
    else if(value.gitlink&&!from.startsWith(APP_REFERENCE)){if(!gitlinks.some(link=>link.path===value.gitlink))problem(from,pointer||'/','record','The gitlink names no submodule of this repository.');else useLink(value.gitlink,from);}
   }
   if(typeof value.file==='string'&&typeof value.pointer==='string')checkPin(value,from);
   if(value.project&&Object.keys(value).length===1&&projects.has(value.project)&&value.project!==id)inputs.add(value.project);
   for(const [key,child] of Object.entries(value))walk(child,from,pointer+'/'+key.replaceAll('~','~0').replaceAll('/','~1'));
  }
  for(let index=0;index<records.length;index++)walk(records[index][1],records[index][0]);
  // Node loads a .js file by the "type" of its nearest package.json, so that file is an input too.
  const nearestPackage=(relative,has)=>{for(let directory=path.posix.dirname(relative);;directory=path.posix.dirname(directory)){const candidate=directory==='.'?'package.json':directory+'/package.json';if(has(candidate))return candidate;if(directory==='.')return null;}};
  for(const relative of [...files.keys()])if(relative.endsWith('.js')){const found=nearestPackage(relative,isFile);if(found)addFile(found,'node');}
  for(const relative of [...appFiles.keys()])if(relative.endsWith('.js')){const found=nearestPackage(relative,name=>appSet.has(name));if(found)addApp(found,'node');}
  const sources=project.upstreams.map(upstream=>{
   // A gitlink pin is the upstream's own commit; a record inside a checkout is read through its pointer.
   const link=upstream.pin?.gitlink&&linkOf(upstream.pin.gitlink);
   if(link)return {...upstream,gitlink:link.revision};
   // A pin the resolver already reported is not read.
   if(upstream.pin&&unresolved.some(row=>row.expression===JSON.stringify(upstream.pin)))return {...upstream};
   let resolved;try{resolved=resolveUpstream(upstream,root);}catch(error){problem("projects",JSON.stringify(upstream.pin??upstream.id),"pin",error.message);return {...upstream};}
   if(upstream.pin&&(bindings.get(upstream.pin.file)||[]).some(binding=>!binding.select&&binding.pointer===upstream.pin.pointer+'/version')&&resolved.version!==undefined)resolved.version='$packageVersion';
   return resolved;
  });
  const definition={schemaVersion:1,id,build:normalizedBuilds(builds),files:[...files,...[...appFiles].map(([name,digest])=>[APP_REFERENCE+name,digest])].sort(([a],[b])=>ordinal(a,b)).map(([path,sha256])=>({path,sha256})),sources,gitlinks:[...usedLinks.values()].sort((a,b)=>ordinal(a.path,b.path))};
  const result={definition,definitionDigest:reportDigest(definition),inputs:[...inputs].sort().map(id=>({id}))};
  cache.set(id,result);problems.set(id,unresolved);
  return result;
 }
 describe.unresolved=id=>{describe(id);return problems.get(id);};
 return describe;
}

export function recipeBuildReport({id,directory}={}){return createRecipeBuildReporter({directory})(id);}
