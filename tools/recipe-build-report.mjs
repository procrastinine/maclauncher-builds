import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {resolveUpstream} from '../lib/source-pins.mjs';

export function canonicalReport(value){
 if(Array.isArray(value))return '['+value.map(canonicalReport).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonicalReport(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
export const reportDigest=value=>crypto.createHash('sha256').update(canonicalReport(value)).digest('hex');
const inside=(root,file)=>file.startsWith(root+path.sep);
const parsePointer=pointer=>pointer.slice(1).split('/').map(key=>key.replaceAll('~1','/').replaceAll('~0','~'));
function slot(value,pointer){const keys=parsePointer(pointer),key=keys.pop();for(const part of keys){if(!value||!Object.hasOwn(value,part))return null;value=value[part];}return value&&Object.hasOwn(value,key)?{value,key}:null;}
function normalizedBuilds(builds){
 const commands=new Map();for(const {version,...build} of builds){let combined=commands.get(build.command);if(!combined){combined={command:build.command};commands.set(build.command,combined);}for(const [key,value] of Object.entries(build)){if(key==='command')continue;if(Array.isArray(value))combined[key]=[...new Set([...(combined[key]||[]),...value])].sort();else if(value&&typeof value==='object')combined[key]={...combined[key],...value};else if(typeof value==='boolean')combined[key]=!!(combined[key]||value);else combined[key]=value;}}
 return [...commands.values()].sort((a,b)=>a.command.localeCompare(b.command));
}

/** Read production recipes without executing them. Inputs are discovered from
 * the recipe's existing signed-input references, never a second input registry.
 */
export function createRecipeBuildReporter({directory=path.resolve(import.meta.dirname,'..')}={}){
 const root=fs.realpathSync(directory),registry=readProjects(root,{resolvePins:false}),projects=new Map(registry.projects.map(project=>[project.id,project])),cache=new Map();
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'projects.json'))),registryFiles=new Set(['projects.json',...Object.values(manifest.registries||{})]);
 const bindings=new Map();for(const project of projects.values())for(const binding of project.versionBindings||[]){if(!bindings.has(binding.file))bindings.set(binding.file,[]);bindings.get(binding.file).push(binding);}
 let gitlinks=[];try{gitlinks=execFileSync('git',['ls-files','--stage'],{cwd:root,encoding:'utf8',maxBuffer:16<<20,stdio:['ignore','pipe','ignore']}).split('\n').flatMap(line=>{const match=/^160000 ([a-f0-9]{40}) 0\t(.+)$/.exec(line);return match?[{path:match[2],revision:match[1]}]:[];});}catch{/* Non-Git recipe fixtures have no Gitlink inputs. */}
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
  const builds=project.build?buildRecords(project):[],files=new Map(),inputs=new Set(),usedLinks=new Map(),queue=[],queued=new Set();
  const enqueue=file=>{file=path.normalize(file).split(path.sep).join('/');if(registryFiles.has(file)||file.startsWith('catalogs/')||queued.has(file)||path.isAbsolute(file)||file.startsWith('../'))return;queued.add(file);queue.push(file);};
  const rememberLink=file=>{const link=gitlinks.find(link=>file===link.path||file.startsWith(link.path+'/'));if(link)usedLinks.set(link.path,link);return link;};
  const artifactId=value=>{
   if(value?.evidence?.path&&/^attestations\/[a-f0-9]{64}\.json$/.test(value.evidence.path)){const ledger=JSON.parse(fs.readFileSync(path.join(root,value.evidence.path)));return ledger.record?.id;}
   if(typeof value?.url==='string'){
    let url;try{url=new URL(value.url);}catch{return null;}
    const prefix='/'+registry.repository+'/releases/download/';if(url.hostname==='github.com'&&url.pathname.startsWith(prefix)){const tag=decodeURIComponent(url.pathname.slice(prefix.length).split('/')[0]),match=/^([^/]+)\/v([^/]+)\/(arm64|x64|universal)$/.exec(tag);if(match){for(const folder of ['catalogs','catalogs/superseded']){const catalogFile=path.join(root,folder,match[1]+'.json');if(fs.existsSync(catalogFile)){const catalog=JSON.parse(fs.readFileSync(catalogFile));if(catalog.packages.some(record=>record.id===match[1]&&record.version===match[2]&&record.arch===match[3]&&record.asset?.url===value.url&&(!value.sha256||record.asset.sha256===value.sha256)&&(!value.bytes||record.asset.bytes===value.bytes)))return match[1];}}}}
   }
   return null;
  };
  const walkJson=(value,from)=>{
   if(typeof value==='string'){reference(value,from);return value;}
   if(Array.isArray(value))return value.map(child=>walkJson(child,from));
   if(!value||typeof value!=='object')return value;
   const input=artifactId(value);if(input&&projects.has(input)&&input!==id){inputs.add(input);return {buildInput:input};}
   return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,walkJson(child,from)]));
  };
  function reference(literal,from,directories=[]){
   if(typeof literal!=='string'||!/^[-A-Za-z0-9_./@+]+$/.test(literal))return;
   const candidates=[path.resolve(root,path.dirname(from),literal),path.resolve(root,literal),...directories.map(directory=>path.resolve(directory,literal))];
   for(const absolute of candidates){if(!inside(root,absolute))continue;const relative=path.relative(root,absolute).split(path.sep).join('/');rememberLink(relative);if(!fs.statSync(absolute,{throwIfNoEntry:false})?.isFile())continue;if(/\.(?:json|[mc]?js|[ch](?:pp|xx)?|cc|mm|m|rs|toml|lock|patch|metal|glsl|swift|cmake|txt)$/.test(relative)||path.basename(relative)==='CMakeLists.txt'){enqueue(relative);return;}}
  }
  for(const build of builds){enqueue(build.command);for(const source of build.submodules||[])rememberLink(source);}
  for(const entry of project.producer.entries||[])enqueue(entry);
  if(project.producer.recipe)enqueue(project.producer.recipe);
  for(const upstream of project.upstreams)if(upstream.pin){enqueue(upstream.pin.file);rememberLink(upstream.pin.file);}
  while(queue.length){const file=queue.shift(),absolute=path.join(root,file);if(rememberLink(file))continue;
   if(file.startsWith('attestations/')){const record=JSON.parse(fs.readFileSync(absolute)).record;if(record?.id&&record.id!==id&&projects.has(record.id))inputs.add(record.id);continue;}
   if(!fs.statSync(absolute,{throwIfNoEntry:false})?.isFile())continue;
   const bytes=fs.readFileSync(absolute);
   if(file.endsWith('.json')){
    const raw=JSON.parse(bytes),value=walkJson(normalizedJson(file,raw),file);files.set(file,reportDigest(value));
    if(raw.path&&raw.buildEntry){rememberLink(raw.path);reference(path.posix.join(raw.path,raw.buildEntry),file);}
    if(raw.sourceDirectory&&Array.isArray(raw.sources))for(const source of raw.sources)reference(path.posix.join(raw.sourceDirectory,source),file);
   }else{
    files.set(file,crypto.createHash('sha256').update(bytes).digest('hex'));
    if(/\.(?:[mc]?js|[cm]?[ch](?:pp|xx)?|cc|rs|cmake|txt)$/.test(file)){
     const text=bytes.toString('utf8'),literals=[...text.matchAll(/(['"])([^'"\r\n]+)\1/g)].map(match=>match[2]).filter(literal=>/^[-A-Za-z0-9_./@+]+$/.test(literal)),directories=literals.map(literal=>path.resolve(root,literal)).filter(directory=>inside(root,directory)&&fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory());
     for(const literal of literals)reference(literal,file,directories);
    }
   }
  }
  const sources=project.upstreams.map(upstream=>{
   if(upstream.pin&&rememberLink(upstream.pin.file))return {...upstream,gitlink:rememberLink(upstream.pin.file).revision};
   const resolved=resolveUpstream(upstream,root);
   if(upstream.pin&&(bindings.get(upstream.pin.file)||[]).some(binding=>!binding.select&&binding.pointer===upstream.pin.pointer+'/version')&&resolved.version!==undefined)resolved.version='$packageVersion';
   return resolved;
  });
  const definition={schemaVersion:1,id,build:normalizedBuilds(builds),files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256})),sources,gitlinks:[...usedLinks.values()].sort((a,b)=>a.path.localeCompare(b.path))};
  const result={definition,definitionDigest:reportDigest(definition),inputs:[...inputs].sort().map(id=>({id}))};cache.set(id,result);return result;
 }
 return describe;
}

export function recipeBuildReport({id,directory}={}){return createRecipeBuildReporter({directory})(id);}
