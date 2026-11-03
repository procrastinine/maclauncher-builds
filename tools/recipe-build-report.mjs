import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {resolveUpstream} from '../lib/source-pins.mjs';
import {canonicalReport,reportDigest} from '../lib/canonical-report.mjs';
export {canonicalReport,reportDigest};
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
 let gitlinks=[];const tracked=new Map(),trackedFiles=[];try{gitlinks=execFileSync('git',['ls-files','--stage'],{cwd:root,encoding:'utf8',maxBuffer:16<<20,stdio:['ignore','pipe','ignore']}).split('\n').flatMap(line=>{const match=/^(\d+) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);if(!match)return [];if(match[1]!=='160000'){const name=path.posix.basename(match[3]);tracked.set(name,[...(tracked.get(name)||[]),match[3]]);trackedFiles.push(match[3]);return [];}return [{path:match[3],revision:match[2]}];});}catch{/* Non-Git recipe fixtures have no Gitlink inputs. */}
 const unresolvedReferences=new Map(),commandProjects=new Map();
 for(const project of projects.values())for(const build of project.build?buildRecords(project):[]){if(!commandProjects.has(build.command))commandProjects.set(build.command,new Set());commandProjects.get(build.command).add(project.id);}
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
  const builds=project.build?buildRecords(project):[],files=new Map(),inputs=new Set(),usedLinks=new Map(),queue=[],queued=new Set(),unresolved=[],computed=[];
  const enqueue=file=>{file=path.normalize(file).split(path.sep).join('/');if(file.startsWith('tools/publication/')||registryFiles.has(file)||file.startsWith('catalogs/')||queued.has(file)||path.isAbsolute(file)||file.startsWith('../'))return;queued.add(file);queue.push(file);};
  const rememberLink=file=>{const link=gitlinks.find(link=>file===link.path||file.startsWith(link.path+'/'));if(link)usedLinks.set(link.path,link);return link;};
  const artifactId=value=>value?.project&&Object.keys(value).length===1&&projects.has(value.project)?value.project:null;
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
   for(const absolute of candidates){if(!inside(root,absolute))continue;const relative=path.relative(root,absolute).split(path.sep).join('/');rememberLink(relative);if(!fs.statSync(absolute,{throwIfNoEntry:false})?.isFile())continue;if(/\.(?:json|[mc]?js|[ch](?:pp|xx)?|cc|mm|m|rs|go|toml|lock|patch|metal|glsl|swift|cmake|txt)$/.test(relative)||path.basename(relative)==='CMakeLists.txt'){enqueue(relative);return;}}
  }
  // Local modules and files are followed the way Node resolves them. Paths
  // computed from other variables are reported, never evaluated.
  const moduleFile=base=>[base,...['.js','.cjs','.mjs','.json'].map(extension=>base+extension),path.join(base,'index.js')].find(candidate=>fs.statSync(candidate,{throwIfNoEntry:false})?.isFile());
  function local(absolute,from,expression){
   if(absolute!==root&&!inside(root,absolute)){unresolved.push({file:from,expression,reason:'outside'});return;}
   const relative=path.relative(root,absolute).split(path.sep).join('/'),stat=fs.statSync(absolute,{throwIfNoEntry:false});
   if(rememberLink(relative))return;
   if(stat?.isFile())enqueue(relative);else if(!stat?.isDirectory())unresolved.push({file:from,expression,reason:'missing'});
  }
  function modules(text,from){
   const directory=path.dirname(path.join(root,from)),strings=list=>[...list.matchAll(/(['"])([^'"\r\n]*)\1/g)].map(match=>match[2]);
   for(const match of text.matchAll(/\b(?:require(?:\.resolve)?\(|import\()\s*(['"])(\.{1,2}(?:\/[^'"\r\n]*)?)\1\s*[,)]|\b(?:from|import)\s*(['"])(\.{1,2}(?:\/[^'"\r\n]*)?)\3/g)){const base=path.resolve(directory,match[2]??match[4]);local(moduleFile(base)||base,from,match[0]);}
   for(const match of text.matchAll(/\bnew URL\(\s*(['"])([^'":\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/g))local(path.resolve(directory,match[2]),from,match[0]);
   for(const match of text.matchAll(/\bpath\.(?:posix\.)?(?:join|resolve)\(\s*([A-Za-z_$][\w$.]*)\s*((?:,\s*(['"])[^'"\r\n]*\3\s*)+)\)/g)){
    const parts=strings(match[2]);
    if(match[1]==='__dirname'||match[1]==='import.meta.dirname')local(path.resolve(directory,...parts),from,match[0]);
    else if(/\.[A-Za-z0-9]+$/.test(parts.at(-1)))computed.push({file:from,expression:match[0],tail:path.posix.join(...parts)});
   }
  }
  for(const build of builds){enqueue(build.command);for(const source of build.submodules||[])rememberLink(source);}
  // A directory entry declares every tracked file below it.
  const directoryFiles=directory=>trackedFiles.length?trackedFiles.filter(file=>file.startsWith(directory+'/')):fs.readdirSync(path.join(root,directory),{recursive:true}).map(name=>path.posix.join(directory,name.split(path.sep).join('/'))).filter(file=>fs.statSync(path.join(root,file)).isFile());
  if(fs.existsSync(path.join(root,'.github/actions/build-runtime/action.yml')))enqueue('.github/actions/build-runtime/action.yml');
  for(const entry of project.producer.entries||[]){if(fs.statSync(path.join(root,entry),{throwIfNoEntry:false})?.isDirectory())for(const file of directoryFiles(entry))enqueue(file);else enqueue(entry);}
  if(project.producer.recipe)enqueue(project.producer.recipe);
  for(const upstream of project.upstreams)if(upstream.pin){enqueue(upstream.pin.file);rememberLink(upstream.pin.file);}
  while(queue.length){const file=queue.shift(),absolute=path.join(root,file);if(rememberLink(file))continue;
   if(!fs.statSync(absolute,{throwIfNoEntry:false})?.isFile())continue;
   const bytes=fs.readFileSync(absolute);
   if(file.endsWith('.yml'))for(const match of bytes.toString('utf8').matchAll(/\bnode (tools\/[A-Za-z0-9_./-]+\.mjs)\b/g))enqueue(match[1]);
   if(file.endsWith('.json')){
    const raw=JSON.parse(bytes),value=walkJson(normalizedJson(file,raw),file);files.set(file,reportDigest(value));
    if(raw.path&&raw.buildEntry){rememberLink(raw.path);reference(path.posix.join(raw.path,raw.buildEntry),file);}
    if(raw.sourceDirectory&&Array.isArray(raw.sources))for(const source of raw.sources)reference(path.posix.join(raw.sourceDirectory,source),file);
   }else{
    files.set(file,crypto.createHash('sha256').update(bytes).digest('hex'));
    if(/\.(?:[mc]?js|[cm]?[ch](?:pp|xx)?|cc|rs|cmake|txt)$/.test(file)){
     const text=bytes.toString('utf8'),literals=[...text.matchAll(/(['"])([^'"\r\n]+)\1/g)].map(match=>match[2]).filter(literal=>/^[-A-Za-z0-9_./@+]+$/.test(literal)),directories=literals.map(literal=>path.resolve(root,literal)).filter(directory=>inside(root,directory)&&fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory());
     for(const match of text.matchAll(/\bpreparedBuildInput\(\s*['"]([a-z0-9-]+)['"]/g))if(projects.has(match[1])&&match[1]!==id)inputs.add(match[1]);
     for(const literal of literals)reference(literal,file,directories);
     if(/\.[mc]?js$/.test(file))modules(text,file);
    }
   }
  }
  let declared=false;
  for(const build of builds){const command=path.join(root,build.command);if(/export\s+function\s+recipeInputs\b/.test(fs.readFileSync(command,'utf8'))){const report=require(command).recipeInputs({project:id,version:build.version});inputs.clear();for(const input of report){if(!projects.has(input)||input===id)throw Error('The recipe reports an invalid package input: '+input);inputs.add(input);}declared=true;break;}}
  // Discovery reads every reference in a shared command, so a command that builds
  // several projects reports each project's own inputs through recipeInputs.
  const shared=builds.find(build=>commandProjects.get(build.command).size>1);
  if(shared&&!declared&&inputs.size)throw Error('The shared build command '+shared.command+' must report the inputs of '+id+' through recipeInputs.');
  const sources=project.upstreams.map(upstream=>{
   if(upstream.pin&&rememberLink(upstream.pin.file))return {...upstream,gitlink:rememberLink(upstream.pin.file).revision};
   const resolved=resolveUpstream(upstream,root);
   if(upstream.pin&&(bindings.get(upstream.pin.file)||[]).some(binding=>!binding.select&&binding.pointer===upstream.pin.pointer+'/version')&&resolved.version!==undefined)resolved.version='$packageVersion';
   return resolved;
  });
  const definition={schemaVersion:1,id,build:normalizedBuilds(builds),files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256})),sources,gitlinks:[...usedLinks.values()].sort((a,b)=>a.path.localeCompare(b.path))};
  const result={definition,definitionDigest:reportDigest(definition),inputs:[...inputs].sort().map(id=>({id}))};cache.set(id,result);
  // A computed path is reported when it names repository files and none of them is part of the definition.
  unresolvedReferences.set(id,[...unresolved,...computed.flatMap(({tail,...row})=>{const matches=(tracked.get(path.posix.basename(tail))||[]).filter(file=>file===tail||file.endsWith('/'+tail));const named=matches.filter(file=>!registryFiles.has(file)&&!file.startsWith('catalogs/'));return !named.length||matches.some(file=>files.has(file))?[]:[{...row,reason:'computed',matches:named}];})]);
  return result;
 }
 describe.unresolved=id=>{describe(id);return unresolvedReferences.get(id);};
 return describe;
}

export function recipeBuildReport({id,directory}={}){return createRecipeBuildReporter({directory})(id);}
