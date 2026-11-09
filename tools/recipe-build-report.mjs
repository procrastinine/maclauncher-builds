import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {resolveUpstream} from '../lib/source-pins.mjs';
import {sourceRecordProblem} from '../lib/pins.mjs';
import {APP_REFERENCE,appSourceRoot} from './app-source.mjs';
import {canonicalReport,reportDigest} from '../lib/canonical-report.mjs';
export {canonicalReport,reportDigest};
const inside=(root,file)=>file.startsWith(root+path.sep);
const IMPORTS=/\b(?:require(?:\.resolve)?\(|import\()\s*(['"])(\.{1,2}(?:\/[^'"\r\n]*)?)\1\s*[,)]|\b(?:from|import)\s*(['"])(\.{1,2}(?:\/[^'"\r\n]*)?)\3/g;
const APP_HELPERS=/(?<!function\s)\b(appPath|appRequire|appFiles|moduleFile|moduleFiles|exportAppFile|exportModuleTree)\(/g;
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
/** The text of the call argument starting at index, up to its top-level comma
 * or closing parenthesis, or, for a binding, also its semicolon or line end. */
function argument(text,index,binding=false){
 let depth=0,quote=null;
 for(let i=index;i<text.length;i++){
  const c=text[i];
  if(quote){if(c==='\\')i++;else if(c===quote)quote=null;continue;}
  if(c==='"'||c==="'"||c==='`')quote=c;
  else if('([{'.includes(c))depth++;
  else if(')]}'.includes(c)){if(!depth)return text.slice(index,i);depth--;}
  else if(!depth&&(c===','||binding&&(c===';'||c==='\n')))return text.slice(index,i);
 }
 return binding?text.slice(index):null;
}
const splitArguments=text=>{const parts=[];let rest=text;while(rest.trim()){const part=argument(rest+')',0);parts.push(part);rest=rest.slice(part.length+1);}return parts;};
/** The static values of a path expression: a string literal, a constant (each
 * static value bound to that name), their concatenation or path.join, or a
 * template literal. A value that ends in a computed part is a prefix naming
 * the directory it lies in. */
function staticPaths(expression,constants){
 const text=expression.trim();let match;
 if((match=/^(['"])([^'"\\]*)\1$/.exec(text)))return [{value:match[2],exact:true}];
 if((match=/^`([^`$\\]*)`$/.exec(text)))return [{value:match[1],exact:true}];
 if((match=/^`([^`$\\]*)\$\{/.exec(text)))return [{value:match[1],exact:false}];
 if(constants.has(text))return constants.get(text);
 if((match=/^((['"])[^'"\\]*\2|[A-Za-z_$][\w$]*)\s*\+([\s\S]+)$/.exec(text))){
  const heads=staticPaths(match[1],constants),rests=staticPaths(match[3],constants);
  return heads.flatMap(head=>!head.exact?[head]:rests.length?rests.map(rest=>({value:head.value+rest.value,exact:rest.exact})):[{value:head.value,exact:false}]);
 }
 if((match=/^path\.(?:posix\.)?join\(([\s\S]*)\)$/.exec(text))){
  let values=null;
  for(const part of splitArguments(match[1])){
   const options=staticPaths(part,constants);
   if(!values){values=options;if(!values.length)return [];continue;}
   values=values.flatMap(value=>!value.exact?[value]:options.length?options.map(option=>({value:path.posix.join(value.value,option.value)+(option.exact?'':'/'),exact:option.exact})):[{value:value.value+'/',exact:false}]);
  }
  return (values||[]).map(value=>value.exact?{value:path.posix.normalize(value.value),exact:true}:value);
 }
 return [];
}
const staticTarget=({value,exact})=>exact?path.posix.normalize(value):value.endsWith('/')?path.posix.normalize(value):path.posix.dirname(value+'_');
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
 let gitlinks=[];const tracked=new Map(),trackedFiles=[];try{gitlinks=execFileSync('git',['ls-files','--stage'],{cwd:root,encoding:'utf8',maxBuffer:Infinity,stdio:['ignore','pipe','ignore']}).split('\n').flatMap(line=>{const match=/^(\d+) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);if(!match)return [];if(match[1]!=='160000'){const name=path.posix.basename(match[3]);tracked.set(name,[...(tracked.get(name)||[]),match[3]]);trackedFiles.push(match[3]);return [];}return [{path:match[3],revision:match[2]}];});}catch{/* Non-Git recipe fixtures have no Gitlink inputs. */}
 // The pinned app checkout is read in place, as tools/app-source.mjs reads it.
 const appSource=fs.existsSync(path.join(root,'producers/package-support/app-source.json'))?appSourceRoot(root):null;
 const appTracked=new Set(appSource?execFileSync('git',['-C',appSource.directory,'ls-files','-z'],{encoding:'utf8',maxBuffer:Infinity}).split('\0').filter(Boolean):[]);
 const appDigests=new Map(),appDigest=relative=>{
  if(!appDigests.has(relative)){let value=null;try{const file=path.join(appSource.directory,relative);value=fs.statSync(file).isDirectory()?'directory':sha256(fs.readFileSync(file));}catch{}appDigests.set(relative,value);}
  return appDigests.get(relative);
 };
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
  const appFiles=new Map(),checkedRecords=new Set();
  // App files are named by their path in the app repository: a file, a module
  // resolved the way Node resolves it, or a directory of tracked files.
  function appReference(value,from,expression,follow=false){
   const relative=path.posix.normalize(String(value)).replace(/\/+$/,'');
   if(!appSource||!relative||relative==='.'||relative.startsWith('../')||relative.startsWith('/')){unresolved.push({file:from,expression,reason:'missing'});return;}
   const file=[relative,...['.js','.cjs','.mjs','.json'].map(extension=>relative+extension)].find(candidate=>appTracked.has(candidate));
   if(file){addApp(file,from,expression,follow);return;}
   const below=[...appTracked].filter(name=>name.startsWith(relative+'/'));
   if(below.length)for(const name of below)addApp(name,from,expression,false);
   else unresolved.push({file:from,expression,reason:'missing'});
  }
  function addApp(relative,from,expression,follow){
   if(appFiles.has(relative))return;
   const digest=appDigest(relative);
   if(digest===null){unresolved.push({file:from,expression,reason:'missing'});return;}
   if(digest==='directory')return;
   appFiles.set(relative,digest);
   const absolute=path.join(appSource.directory,relative);
   if(relative.endsWith('.json'))checkRecords(JSON.parse(fs.readFileSync(absolute)),APP_REFERENCE+relative);
   if(follow&&/\.[mc]?js$/.test(relative))for(const match of fs.readFileSync(absolute,'utf8').matchAll(IMPORTS))appReference(path.posix.join(path.posix.dirname(relative),match[2]??match[4]),APP_REFERENCE+relative,match[0],true);
  }
  // A module directory is shared by layout: Builds keeps producers/package-support/<path>,
  // the app keeps <path>; moduleFile prefers the Builds file.
  const appExists=relative=>{relative=path.posix.normalize(relative).replace(/\/+$/,'');return [relative,...['.js','.cjs','.mjs','.json'].map(extension=>relative+extension)].some(candidate=>appTracked.has(candidate))||[...appTracked].some(name=>name.startsWith(relative+'/'));};
  const moduleExists=relative=>fs.existsSync(path.join(root,'producers/package-support',relative))||appExists(relative);
  function moduleReference(target,from,expression,file){
   const owned='producers/package-support/'+target,stat=fs.statSync(path.join(root,owned),{throwIfNoEntry:false});
   if(stat?.isFile()){enqueue(owned);if(file)return;}
   else if(stat?.isDirectory())for(const name of directoryFiles(owned))enqueue(name);
   if(appTracked.has(target)||[...appTracked].some(name=>name.startsWith(target+'/')))appReference(target,from,expression,file);
   else if(!stat)unresolved.push({file:from,expression,reason:'missing'});
  }
  function appCalls(text,from){
   if(!/app-source\.mjs['"]/.test(text))return;
   // A constant is a name every binding of which is a static path expression.
   const names=new Set([...text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)].map(match=>match[1]));
   const bindings=new Map();
   for(const name of names){
    const word=name.replace(/\$/g,'\\$');
    if(new RegExp('(?<![\\w$.])'+word+'\\s*=>|for\\s*\\(\\s*(?:const|let|var)\\s+'+word+'\\b|\\((?:\\s*[\\w$]+\\s*,)*\\s*'+word+'\\s*(?:,\\s*[\\w$]+\\s*)*\\)\\s*=>|function\\s*[\\w$]*\\s*\\([^)]*\\b'+word+'\\b[^)]*\\)').test(text))continue;
    bindings.set(name,[...text.matchAll(new RegExp('(?<![\\w$.])'+word+'\\s*=(?![=>])','g'))].map(match=>argument(text,match.index+match[0].length,true)));
   }
   let constants=new Map();
   for(let pass=0;pass<4;pass++){
    const next=new Map();
    for(const [name,expressions] of bindings){
     const values=expressions.map(expression=>staticPaths(expression,constants));
     if(values.every(options=>options.length))next.set(name,[...new Map(values.flat().map(option=>[option.value+'\0'+option.exact,option])).values()]);
    }
    if(next.size===constants.size&&[...next].every(([name,values])=>constants.get(name)?.length===values.length))break;
    constants=next;
   }
   const bases=new Map();
   for(const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*appPath\(/g)){const value=argument(text,match.index+match[0].length),targets=value===null?[]:staticPaths(value,constants).filter(target=>target.exact);if(targets.length)bases.set(match[1],[...new Set([...(bases.get(match[1])||[]),...targets.map(target=>path.posix.normalize(target.value))])]);}
   for(const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*appSourceRoot\(\)(\.directory\b)?/g))bases.set(match[2]?match[1]:match[1]+'.directory',['.']);
   for(const match of text.matchAll(APP_HELPERS)){
    const value=argument(text,match.index+match[0].length);if(value===null)continue;
    const expression=match[0]+value+')',targets=staticPaths(value,constants);
    if(!targets.length){unresolved.push({file:from,expression,reason:'app'});continue;}
    const module=['moduleFile','moduleFiles','exportModuleTree'].includes(match[1]),found=targets.filter(target=>module?moduleExists(staticTarget(target)):appExists(staticTarget(target)));
    if(!found.length){unresolved.push({file:from,expression,reason:'missing'});continue;}
    for(const target of found)if(module)moduleReference(staticTarget(target),from,expression,match[1]==='moduleFile'&&target.exact);else appReference(staticTarget(target),from,expression,match[1]==='appRequire');
   }
   for(const match of text.matchAll(/\bpath\.(?:posix\.)?(?:join|resolve)\(\s*([A-Za-z_$][\w$.]*)\s*((?:,\s*(['"])[^'"\r\n]*\3\s*)+)\)/g))
    if(bases.has(match[1])){const parts=[...match[2].matchAll(/(['"])([^'"\r\n]*)\1/g)].map(part=>part[2]),targets=bases.get(match[1]).map(base=>path.posix.join(base,...parts)),found=targets.filter(appExists);if(found.length)for(const target of found)appReference(target,from,match[0]);else unresolved.push({file:from,expression:match[0],reason:'missing'});}
  }
  // Source records name their pin with one field, and pins point at records.
  function checkRecords(value,from,pointer=''){
   if(Array.isArray(value)){value.forEach((child,index)=>checkRecords(child,from,pointer+'/'+index));return;}
   if(!value||typeof value!=='object')return;
   if(Object.hasOwn(value,'commit')||Object.hasOwn(value,'gitlink')||typeof value.revision==='string'){
    const problem=sourceRecordProblem(value);
    if(problem)unresolved.push({file:from,expression:pointer||'/',reason:'record',problem});
    else if(value.gitlink&&!from.startsWith(APP_REFERENCE)&&!gitlinks.some(link=>link.path===value.gitlink))unresolved.push({file:from,expression:pointer||'/',reason:'record',problem:'The gitlink names no submodule of this repository.'});
   }
   for(const [key,child] of Object.entries(value))checkRecords(child,from,pointer+'/'+key.replaceAll('~','~0').replaceAll('/','~1'));
  }
  function checkPin(pin,from){
   const expression=JSON.stringify(pin);let file;
   if(pin.file.startsWith(APP_REFERENCE)){const relative=pin.file.slice(APP_REFERENCE.length);appReference(relative,from,expression);if(!appTracked.has(relative))return;file=path.join(appSource.directory,relative);}
   else{file=jsonCandidates(from,pin.file).find(candidate=>fs.statSync(candidate,{throwIfNoEntry:false})?.isFile());if(!file){unresolved.push({file:from,expression,reason:'missing'});return;}enqueue(path.relative(root,file));}
   if(!file.endsWith('.json')||pin.match)return;
   let target=JSON.parse(fs.readFileSync(file));
   for(const key of pin.pointer?parsePointer(pin.pointer):[]){if(!target||typeof target!=='object'||!Object.hasOwn(target,key)){unresolved.push({file:from,expression,reason:'pin'});return;}target=target[key];}
   if(target&&typeof target==='object'&&['commit','revision','gitlink'].some(key=>Object.hasOwn(target,key))){const problem=sourceRecordProblem(target);if(problem)unresolved.push({file:from,expression,reason:'record',problem});}
  }
  // A relative path in recipe JSON is relative to the JSON file's directory or one of its parents.
  const jsonCandidates=(from,value)=>{const candidates=[];for(let directory=path.dirname(path.join(root,from));inside(root,directory)||directory===root;directory=path.dirname(directory)){candidates.push(path.resolve(directory,value));if(directory===root)break;}return candidates.filter(candidate=>inside(root,candidate));};
  const walkJson=(value,from)=>{
   if(typeof value==='string'){reference(value,from);return value;}
   if(Array.isArray(value))return value.map(child=>walkJson(child,from));
   if(!value||typeof value!=='object')return value;
   if(typeof value.file==='string'&&typeof value.pointer==='string')checkPin(value,from);
   const input=artifactId(value);if(input&&projects.has(input)&&input!==id){inputs.add(input);return {buildInput:input};}
   return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,walkJson(child,from)]));
  };
  function reference(literal,from,directories=[]){
   if(typeof literal==='string'&&/^app:[-A-Za-z0-9_./@+]+$/.test(literal)){appReference(literal.slice(APP_REFERENCE.length),from,literal);return;}
   if(typeof literal!=='string'||!/^[-A-Za-z0-9_./@+]+$/.test(literal))return;
   const candidates=[path.resolve(root,path.dirname(from),literal),path.resolve(root,literal),...(from.endsWith('.json')?jsonCandidates(from,literal):[]),...directories.map(directory=>path.resolve(directory,literal))];
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
  for(const entry of project.producer.entries||[]){const stat=fs.statSync(path.join(root,entry),{throwIfNoEntry:false});if(stat?.isDirectory())for(const file of directoryFiles(entry))enqueue(file);else if(stat)enqueue(entry);else unresolved.push({file:'projects',expression:entry,reason:'missing'});}
  if(project.producer.recipe)enqueue(project.producer.recipe);
  for(const upstream of project.upstreams)if(upstream.pin){if(upstream.pin.gitlink)rememberLink(upstream.pin.gitlink);else{enqueue(upstream.pin.file);rememberLink(upstream.pin.file);}}
  while(queue.length){const file=queue.shift(),absolute=path.join(root,file);if(rememberLink(file))continue;
   if(!fs.statSync(absolute,{throwIfNoEntry:false})?.isFile())continue;
   const bytes=fs.readFileSync(absolute);
   if(file.endsWith('.yml')){
    const text=bytes.toString('utf8');
    for(const match of text.matchAll(/\bnode (tools\/[A-Za-z0-9_./-]+\.mjs)\b/g))enqueue(match[1]);
    for(const match of text.matchAll(/\buses:\s*\.\/([A-Za-z0-9_./-]+)/g))enqueue(path.posix.join(match[1],'action.yml'));
    const main=/^\s+main:\s*([^\s'"]+\.[mc]?js)\s*$/m.exec(text)?.[1];if(main)enqueue(path.posix.join(path.posix.dirname(file),main));
   }
   if(file.endsWith('.json')){
    const raw=JSON.parse(bytes),value=walkJson(normalizedJson(file,raw),file);files.set(file,reportDigest(value));checkRecords(raw,file);
    if(raw.path&&raw.buildEntry){rememberLink(raw.path);reference(path.posix.join(raw.path,raw.buildEntry),file);}
    if(raw.sourceDirectory&&Array.isArray(raw.sources))for(const source of raw.sources)reference(path.posix.join(raw.sourceDirectory,source),file);
   }else{
    files.set(file,crypto.createHash('sha256').update(bytes).digest('hex'));
    if(/\.(?:[mc]?js|[cm]?[ch](?:pp|xx)?|cc|rs|cmake|txt)$/.test(file)){
     const text=bytes.toString('utf8'),literals=[...text.matchAll(/(['"])([^'"\r\n]+)\1/g)].map(match=>match[2]).filter(literal=>/^[-A-Za-z0-9_./@+]+$/.test(literal)),directories=literals.map(literal=>path.resolve(root,literal)).filter(directory=>inside(root,directory)&&fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory());
     for(const match of text.matchAll(/\bpreparedBuildInput\(\s*['"]([a-z0-9-]+)['"]/g))if(projects.has(match[1])&&match[1]!==id)inputs.add(match[1]);
     for(const literal of literals)reference(literal,file,directories);
     for(const match of text.matchAll(/(['"])app:([-A-Za-z0-9_./@+]+)\1/g))appReference(match[2],file,match[0]);
     if(/\.[mc]?js$/.test(file))appCalls(text,file);
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
   if(upstream.pin&&rememberLink(upstream.pin.gitlink||upstream.pin.file))return {...upstream,gitlink:rememberLink(upstream.pin.gitlink||upstream.pin.file).revision};
   const resolved=resolveUpstream(upstream,root);
   if(upstream.pin&&(bindings.get(upstream.pin.file)||[]).some(binding=>!binding.select&&binding.pointer===upstream.pin.pointer+'/version')&&resolved.version!==undefined)resolved.version='$packageVersion';
   return resolved;
  });
  const definition={schemaVersion:1,id,build:normalizedBuilds(builds),files:[...files,...[...appFiles].map(([name,digest])=>[APP_REFERENCE+name,digest])].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256})),sources,gitlinks:[...usedLinks.values()].sort((a,b)=>a.path.localeCompare(b.path))};
  const result={definition,definitionDigest:reportDigest(definition),inputs:[...inputs].sort().map(id=>({id}))};cache.set(id,result);
  // A computed path is reported when it names repository files and none of them is part of the definition.
  unresolvedReferences.set(id,[...unresolved,...computed.flatMap(({tail,...row})=>{const matches=(tracked.get(path.posix.basename(tail))||[]).filter(file=>file===tail||file.endsWith('/'+tail));const named=matches.filter(file=>!registryFiles.has(file)&&!file.startsWith('catalogs/'));return !named.length||matches.some(file=>files.has(file))?[]:[{...row,reason:'computed',matches:named}];})]);
  return result;
 }
 describe.unresolved=id=>{describe(id);return unresolvedReferences.get(id);};
 return describe;
}

export function recipeBuildReport({id,directory}={}){return createRecipeBuildReporter({directory})(id);}
