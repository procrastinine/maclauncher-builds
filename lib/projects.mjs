import {treeSource} from './tree-source.mjs';
import path from 'node:path';
import {projectId,repository,version} from './project-identity.mjs';
import {resolveUpstream} from './source-pins.mjs';
import {sourceRecordProblem,sourceRevision} from './pins.mjs';
import {HOSTED_RUNNERS} from './hosted-runners.mjs';
const relativeEntry=value=>typeof value==='string'&&value.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)&&part!=='.'&&part!=='..');
// A lock-file archive pin names, for the record's url and SHA-256 or SHA-512, the lock variables holding them.
const lockKeys=keys=>Boolean(keys)&&typeof keys==='object'&&!Array.isArray(keys)&&Object.hasOwn(keys,'url')&&(Object.hasOwn(keys,'sha256')||Object.hasOwn(keys,'sha512'))&&Object.entries(keys).every(([field,key])=>['url','sha256','sha512'].includes(field)&&/^[A-Z][A-Z0-9_]*$/.test(key));
export function validateVersionBindings(bindings){
 if(bindings===undefined)return;
 const pointer=value=>typeof value==='string'&&/^\/(?:[^~]|~[01])+$/.test(value)&&!value.split('/').some(part=>['__proto__','prototype','constructor'].includes(part));
 if(!Array.isArray(bindings)||!bindings.length||bindings.some(binding=>!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).some(key=>!['file','pointer','select'].includes(key))||!relativeEntry(binding.file)||!binding.file.endsWith('.json')||!pointer(binding.pointer)||binding.select===undefined&&!/\/(?:version|packageVersion)$/.test(binding.pointer)||binding.select!==undefined&&(!binding.select||typeof binding.select!=='object'||Array.isArray(binding.select)||!Object.keys(binding.select).length||Object.entries(binding.select).some(([key,value])=>!/^[$A-Za-z_][A-Za-z0-9_-]*$/.test(key)||['__proto__','prototype','constructor'].includes(key)||!['string','number','boolean'].includes(typeof value)))))throw Error('Invalid package version bindings.');
}
/** A GitHub build runs one producer command for each declared package architecture. */
export function buildRecords(project){
 const records=Array.isArray(project.build)?project.build:[project.build];
 if(!records.length||new Set(records.map(record=>record?.version)).size!==records.length)throw Error('GitHub builds require distinct declared versions.');
 return records.map(build=>buildRecord({...project,build}));
}
export function buildRecord(project,selectedVersion){
 const records=Array.isArray(project.build)?project.build:[project.build];
 const build=selectedVersion===undefined?records[0]:records.find(record=>record.version===selectedVersion),architectures=build?.architectures;
 if(!build||typeof build!=='object'||Array.isArray(build)||Object.keys(build).some(key=>!['version','command','architectures','submodules','inputs','tools','rustComponents','recursiveSubmodules','runners','rustTargets','cleanupRunner','archives','locks','notes'].includes(key))||
  project.producer?.kind==='prebuilt'||!relativeEntry(build.command)||!/\.(?:mjs|cjs|js)$/.test(build.command)||
  !(project.producer.sourceDirectory&&build.command.startsWith(project.producer.sourceDirectory+'/')||build.command.startsWith('tools/')))throw Error('Invalid GitHub build command.');
 if(build.notes!==undefined&&(typeof build.notes!=='string'||!build.notes.trim()||/[\r\n]/.test(build.notes)))throw Error('Build notes must be a nonempty single line.');
 if(!Array.isArray(architectures)||!architectures.length||new Set(architectures).size!==architectures.length||architectures.some(arch=>!['arm64','x64','universal'].includes(arch)))throw Error('A GitHub build declares distinct arm64, x64 or universal outputs.');
 if(build.recursiveSubmodules!==undefined&&typeof build.recursiveSubmodules!=='boolean')throw Error('Recursive submodule selection must be a boolean.');
 if(build.cleanupRunner!==undefined&&typeof build.cleanupRunner!=='boolean')throw Error('Runner cleanup selection must be a boolean.');
 if(build.runners!==undefined&&(!build.runners||typeof build.runners!=='object'||Array.isArray(build.runners)||Object.entries(build.runners).some(([arch,runner])=>!architectures.includes(arch)||!Object.hasOwn(HOSTED_RUNNERS,runner))))throw Error('Build runners must name a supported standard GitHub-hosted runner for a declared architecture.');
 // Each archive pin names, by file and JSON pointer, the archive records the build reads; the input step fetches them.
 // An archive pin with an architecture is read only by that architecture's build.
 if(build.archives!==undefined&&(!Array.isArray(build.archives)||!build.archives.length||new Set(build.archives.map(pin=>JSON.stringify(pin))).size!==build.archives.length||!build.archives.every(pin=>pin&&typeof pin==='object'&&!Array.isArray(pin)&&(pin.arch===undefined||architectures.includes(pin.arch))&&relativeEntry(pin.file)&&(['file,pointer','arch,file,pointer'].includes(Object.keys(pin).sort().join())&&pin.file.endsWith('.json')&&typeof pin.pointer==='string'&&(pin.pointer===''||pin.pointer.startsWith('/'))||['file,keys','arch,file,keys'].includes(Object.keys(pin).sort().join())&&!pin.file.endsWith('.json')&&lockKeys(pin.keys)))))throw Error('Invalid GitHub build archives.');
 // Each lock names a Cargo.lock, go.sum, NuGet packages.lock.json or SwiftPM Package.resolved the compile reads; prepare fetches what it names.
 if(build.locks!==undefined&&(!Array.isArray(build.locks)||!build.locks.length||new Set(build.locks.map(lock=>lock?.file)).size!==build.locks.length||!build.locks.every(lock=>lock&&typeof lock==='object'&&!Array.isArray(lock)&&Object.keys(lock).sort().join()==='file,tool'&&relativeEntry(lock.file)&&({cargo:/\.lock$/,go:/(^|\/)go\.sum$/,nuget:/\.json$/,swiftpm:/(^|\/)Package\.resolved$/}[lock.tool]?.test(lock.file)))))throw Error('Invalid GitHub build locks.');
 // The version that the command produces; changing it declares a new GitHub build.
 if(!(project.packageProfiles||[]).some(profile=>profile.version===build.version))throw Error('A GitHub build names a version declared in the package profiles.');
 for(const [key,valid] of [['submodules',relativeEntry],['inputs',value=>/^[a-z0-9][a-z0-9-]*$/.test(value||'')],['rustTargets',value=>/^[a-z0-9_]+(?:-[a-z0-9_.]+){1,3}$/.test(value||'')],['rustComponents',value=>/^[a-z][a-z0-9-]{0,63}$/.test(value||'')],['tools',value=>/^[a-z0-9][a-z0-9@+._-]{0,63}$/.test(value||'')]]){
  const list=build[key];
  if(list!==undefined&&(!Array.isArray(list)||!list.length||new Set(list).size!==list.length||!list.every(valid)))throw Error('Invalid GitHub build '+key+'.');
 }
 return build;
}
export function readProjects(root=path.resolve(import.meta.dirname,'..'),{resolvePins=true,source=treeSource(root)}={}){
 const pinCache=new Map();
 const manifest=source.json('projects.json');
 const deliveries=['downloadable','bundled'];
 let value=manifest;
 if(manifest.schemaVersion===2){
  if(!manifest.registries||Array.isArray(manifest.registries)||Object.keys(manifest.registries).length!==deliveries.length||deliveries.some(delivery=>!Object.hasOwn(manifest.registries,delivery))||Object.hasOwn(manifest,'projects'))throw Error('Invalid project delivery registries.');
  const files=new Set(),projects=[];
  for(const delivery of deliveries){
   const file=manifest.registries[delivery];
   if(typeof file!=='string'||!/^projects\/[a-z0-9-]+\.json$/.test(file)||files.has(file))throw Error('Invalid project delivery registry path.');
   files.add(file);const entries=source.json(file);
   if(!Array.isArray(entries)||!entries.length)throw Error('Empty project delivery registry.');
   for(const project of entries){if(!project||typeof project!=='object'||Array.isArray(project)||Object.hasOwn(project,'delivery'))throw Error('Project delivery is determined by its registry.');projects.push({...project,delivery});}
  }
  value={schemaVersion:1,repository:manifest.repository,updatePolicy:manifest.updatePolicy,projects};
 }
 if(value.schemaVersion!==1||value.updatePolicy!=='manual'||!Array.isArray(value.projects)||!value.projects.length)throw Error('Invalid project registry.');
 repository(value.repository);const seen=new Set();
 for(const project of value.projects){
  if(!project||!['downloadable','bundled'].includes(project.delivery))throw Error('Every project requires a delivery classification.');
  projectId(project.id);if(seen.has(project.id)||typeof project.name!=='string'||!project.name.trim()||!['pinned-source','maclauncher','prebuilt'].includes(project.producer?.kind)||!Array.isArray(project.upstreams))throw Error('Invalid or duplicate project registration.');
  if(project.producer.sourceRepository!==undefined&&!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(project.producer.sourceRepository))throw Error('Product source repository must identify a public GitHub repository.');
  if(project.producer.kind==='pinned-source'&&project.producer.recipe!==`runtimes/${project.id}/source.json`)throw Error('Producer recipe belongs to a different project.');
  if(project.producer.kind==='maclauncher'&&(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.producer.repository||'')||!Array.isArray(project.producer.entries)||project.producer.entries.some(entry=>!relativeEntry(entry))))throw Error('Invalid MacLauncher producer entries.');
  if(project.producer.appEntries!==undefined&&(!Array.isArray(project.producer.appEntries)||!project.producer.appEntries.length||new Set(project.producer.appEntries).size!==project.producer.appEntries.length||project.producer.appEntries.some(entry=>!relativeEntry(entry))))throw Error('Invalid app entries.');
  if(project.producer.sourceDirectory!==undefined&&!relativeEntry(project.producer.sourceDirectory))throw Error("Invalid producer source directory.");
  if(project.producer.kind==='prebuilt'&&(typeof project.producer.version!=='string'||!Array.isArray(project.producer.architectures)||!project.producer.architectures.length||project.producer.architectures.some(arch=>!['arm64','x64'].includes(arch))))throw Error('Invalid prebuilt producer.');
  const publisherFiles=project.producer.publisherFiles;
  if(publisherFiles!==undefined&&(project.producer.kind!=='prebuilt'||!publisherFiles||typeof publisherFiles!=='object'||Array.isArray(publisherFiles)||
   Object.keys(publisherFiles).some(key=>!['file','sha256'].includes(key))||!relativeEntry(publisherFiles.file)||!publisherFiles.file.endsWith('.json')||
   typeof publisherFiles.sha256!=='string'||!/^[a-f0-9]{64}$/.test(publisherFiles.sha256)))throw Error('Prebuilt publisher files require a public relative JSON path and its SHA-256.');
  if(project.packageProfiles!==undefined){
   if(!Array.isArray(project.packageProfiles)||!project.packageProfiles.length)throw Error('Invalid package ABI profiles.');
   const versions=new Set();for(const profile of project.packageProfiles){version(profile.version);if(versions.has(profile.version)||typeof profile.label!=='string'||!profile.label.trim()||Object.keys(profile).some(key=>!['version','label','anchor'].includes(key)))throw Error('Invalid package ABI profiles.');versions.add(profile.version);if(profile.anchor!==undefined)projectId(profile.anchor);}
  }
  if(project.build!==undefined)buildRecords(project);
  validateVersionBindings(project.versionBindings);
  if(manifest.schemaVersion===2&&project.upstreams.some(upstream=>!upstream||!Object.hasOwn(upstream,'pin')))throw Error('Project registry upstreams must reference producer source pins.');
  const upstreamIds=new Set();
  project.upstreams=project.upstreams.map(upstream=>resolveUpstream(upstream,root,{resolvePins,cache:pinCache,source}));
  for(const upstream of project.upstreams){if(!/^[a-z0-9-]+$/.test(upstream.id||'')||upstreamIds.has(upstream.id)||!['github','gitiles','git'].includes(upstream.provider)||!/^https:\/\//.test(upstream.url||'')||!(upstream.pin&&!resolvePins||/^[a-f0-9]{40}$/.test(upstream.revision||'')||typeof upstream.version==='string'&&upstream.version.length))throw Error('Invalid upstream project identity.');const url=new URL(upstream.url);if(url.username||url.password||url.search||url.hash)throw Error('Upstream URL must identify a public source repository.');if(upstream.provider==='github'&&upstream.url!==`https://github.com/${repository(upstream.repository)}`)throw Error('GitHub source URL belongs to a different upstream project.');upstreamIds.add(upstream.id);}
  for(const upstream of project.upstreams)if(upstream.committedAt!==undefined&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(upstream.committedAt)||!Number.isFinite(Date.parse(upstream.committedAt))))throw Error('Invalid pinned source commit timestamp.');
  seen.add(project.id);
 }
 return value;
}
export function resolveProject(id,directory=path.resolve(import.meta.dirname,'..'),options={}){
 if(typeof directory==='object'){
  options=directory;
  directory=options.directory||path.resolve(import.meta.dirname,'..');
 }
 const {resolvePins=true,at,allowUnrecordedInputs=false}=options;
 const source=options.source||treeSource(directory,{at});
 projectId(id);
 const registry=readProjects(directory,{resolvePins:false,source});
 const project=registry.projects.find(project=>project.id===id);
 if(!project)throw Error('Unknown build project: '+id);
 const cache=new Map(),unrecordedInputs=[];
 const upstreams=project.upstreams.flatMap(upstream=>{
  try{return [resolveUpstream(upstream,directory,{resolvePins,cache,source})];}
  catch(error){
   if(!allowUnrecordedInputs)throw error;
   unrecordedInputs.push({name:upstream.id,reason:error.message});
   return [];
  }
 });
 return {...project,upstreams,releaseRepository:registry.repository,
  ...(unrecordedInputs.length?{unrecordedInputs}:{} )};
}
/** The exact commit of one of a project's declared upstreams. The upstream's registry pin is the one
 * declaration of that commit, so a recipe names the project and the upstream, never a checkout path. */
export function upstreamRevision(id,upstream,root=path.resolve(import.meta.dirname,'..')){
 const row=readProjects(root,{resolvePins:false}).projects.find(project=>project.id===id)?.upstreams.find(row=>row.id===upstream);
 if(!row?.pin)throw Error(id+' declares no pinned upstream '+upstream+'.');
 return sourceRecordProblem(row.pin)?resolveUpstream(row,root).revision:sourceRevision(row.pin,root);
}

export function declaredRecipeEntries(project,manifest,{packageSources=false,source}={}){
 const builds=project.build?(Array.isArray(project.build)?project.build:[project.build]):[];
 const entries=[
  ...(packageSources?[]:manifest.buildCode||[]),...builds.map(build=>build.command),
  ...(project.producer.entries||[]),
  ...(project.producer.appEntries||[]).map(name=>'app:'+name),project.producer.recipe
 ];
 if(!packageSources)return [...new Set(entries.filter(Boolean))].sort();
 // The package history follows recipe inputs rather than repository-wide build orchestration.
 const commands=new Set(builds.map(build=>build.command));
 const shared=new Set(manifest.buildCode||[]);
 const owned=entries.filter(entry=>entry&&!entry.startsWith('app:')&&
  (commands.has(entry)||entry===project.producer.recipe||!shared.has(entry)));
 // Materialization records declare exact source files. They narrow broad app directory
 // entries without reading or executing a historical producer's code.
 const materialized=new Set();
 if(source)for(const entry of owned){
  for(const file of source.files(entry).filter(file=>file.endsWith('.json'))){
   let record;try{record=source.json(file);}catch{continue;}
   if(!Array.isArray(record.files))continue;
   for(const input of record.files){
    if(typeof input.source==='string'&&input.source.startsWith('app:'))materialized.add(input.source);
   }
  }
 }
 const app=(project.producer.appEntries||[]).filter(entry=>entry.includes('/')).flatMap(entry=>{
  const name='app:'+entry;
  const exact=[...materialized].filter(file=>file===name||file.startsWith(name+'/'));
  return exact.length?exact:[name];
 });
 return [...new Set([...owned,...app])].sort();
}
