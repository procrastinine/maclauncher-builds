// Package a freshly built executable and its non-system dependency closure.
// Recipes supply public sources and build products; no launcher registry or
// previously reviewed local executable checksum is required.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {managerDeclaration} from './manager-declaration.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {addLicenses,addCargoLicenses,includeLicenses} from '../lib/licenses.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native.js');
const Source=require('../producers/maclauncher/src/modules/shared/runtime/pinned-native-build.js');
const Tools=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const system=value=>value.startsWith('/usr/lib/')||value.startsWith('/System/Library/');
function preparedNativeFiles(){
 const value=process.env.MACLAUNCHER_BUILD_INPUTS;if(!value)return new Set();
 const map=JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8')),files=new Set();
 for(const id of Object.keys(map)){const input=preparedBuildInput(id);for(const file of input.declaration.files)if(file.architectures)files.add(file.size+'/'+file.sha256);}
 return files;
}
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:120000,maxBuffer:Infinity});
export async function sealRuntime({project:id,version:selectedVersion,arch,executable,sourceRoot,sourceScope,cargoRoot=sourceRoot,upstreamRevision,output,executableRelative,appRoot,payloads=[],extraLibraries=[],runtimeFiles={},environmentRelative={},jsonMetadata={},capabilities,env=process.env,provenance={},directory=path.resolve(import.meta.dirname,'..')}) {
 const project=resolveProject(id,directory),build=buildRecord(project,selectedVersion),version=build.version,cpu=arch==='x64'?'x86_64':arch,preparedFiles=preparedNativeFiles(),shared=new Set();
 if(!version||!['arm64','x64'].includes(arch)||!build.architectures.includes(arch)||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(executable||'')||!path.isAbsolute(sourceRoot||'')||!project.upstreams.some(pin=>pin.revision===upstreamRevision))
  throw Error('Sealing needs a registered build, target CPU, pinned public source and a new absolute output directory.');
 await Source.validatePinnedSource(sourceRoot,upstreamRevision,{sourceScope});
 executable=fs.realpathSync(executable);executableRelative??=appRoot?path.basename(appRoot)+'/Contents/MacOS/'+path.basename(executable):'bin/'+path.basename(executable);B.relativeFile(executableRelative);
 const payload=path.join(output,'payload'),files=path.join(payload,'files'),originals=new Map(),targets=new Map(),sources=new Map();
 const copy=(source,relative)=>{B.relativeFile(relative);const target=path.join(files,relative);Tools.copyTree(source,target);return target;};
 fs.mkdirSync(files,{recursive:true});
 try {
  copy(appRoot||executable,appRoot?path.basename(appRoot):executableRelative);
  for(const entry of payloads)copy(entry.source,entry.relative);
  addLicenses(files,id,sourceRoot);addCargoLicenses(files,id,cargoRoot,env);includeLicenses(files,path.join(cargoRoot,'licenses'));
  const roots=[{source:appRoot||executable,relative:appRoot?path.basename(appRoot):executableRelative},...payloads];
  for(const relative of B.fileInventory(files)){
   const target=path.join(files,relative);if(!Tools.macho(target))continue;
   const entry=roots.find(entry=>relative===entry.relative||relative.startsWith(entry.relative+'/'));
   const source=fs.realpathSync(relative===entry.relative?entry.source:path.join(entry.source,relative.slice(entry.relative.length+1)));
   targets.set(source,target);sources.set(target,source);originals.set(source,Native.hashFile(source));
  }
  const addLibrary=source=>{
   source=fs.realpathSync(source);if(targets.has(source))return targets.get(source);
   const relative='lib/'+path.basename(source),target=path.join(files,relative);
   if(fs.existsSync(target)&&Native.hashFile(target)!==Native.hashFile(source))throw Error('Conflicting dependency basename: '+path.basename(source));
   if(!fs.existsSync(target))copy(source,relative);
   targets.set(source,target);sources.set(target,source);originals.set(source,Native.hashFile(source));return target;
  };
  for(const file of extraLibraries)addLibrary(file);
  const queue=[...sources.keys()],seen=new Set(),aliases=new Map(),inherited=Tools.loadCommands(executable,cpu).rpaths;
  for(let i=0;i<queue.length;i++){
   const target=queue[i];if(seen.has(target))continue;seen.add(target);const source=sources.get(target);
   const immutable=preparedFiles.has(fs.statSync(source).size+'/'+Native.hashFile(source));if(immutable)shared.add(target);
   if(!immutable)Tools.thinStagedMachO(target,files,cpu,run);

   const commands=Tools.loadCommands(source,cpu),ids=Tools.libraryIds(source,cpu);
   for(const link of Tools.links(source,cpu)){
    const resolved=Tools.resolveLink(link,source,executable,[...commands.rpaths,...inherited],cpu);
    if(system(link)||ids.includes(link)||!resolved)continue;
    const dependency=addLibrary(resolved);
    if(!immutable)run('/usr/bin/install_name_tool',['-change',link,'@loader_path/'+path.relative(path.dirname(target),dependency).split(path.sep).join('/'),target]);
    else if(link.startsWith('@loader_path/')){
     const alias=path.resolve(path.dirname(target),link.slice('@loader_path/'.length));B.relativeFile(path.relative(files,alias).split(path.sep).join('/'));
     if(alias!==dependency){if(aliases.has(alias)&&aliases.get(alias)!==dependency)throw Error('Conflicting preserved dependency alias.');aliases.set(alias,dependency);}
    }
    queue.push(dependency);
   }
   if(!immutable)for(const rpath of new Set(commands.rpaths.filter(value=>path.isAbsolute(value)&&!system(value))))run('/usr/bin/install_name_tool',['-delete_rpath',rpath,target]);
   if(!immutable&&ids.length)run('/usr/bin/install_name_tool',['-id','@rpath/'+path.basename(target),target]);
  }
  for(const prefix of new Set([...sources.values()].map(source=>path.dirname(path.dirname(source)))))includeLicenses(files,path.join(prefix,'licenses'));
  const formulae=new Map([...sources.values()].map(source=>Tools.formulaRoot(source)).filter(Boolean).map(formula=>[formula.root,formula]));
  for(const formula of formulae.values())addLicenses(files,formula.name+' '+formula.version,formula.root);
  // Upstream source and bottles may use read-only modes; package files are owned copies.
  for(const relative of B.fileInventory(files)){
   const file=path.join(files,relative),executable=Tools.macho(file)||Boolean(fs.statSync(file).mode&0o111);
   fs.chmodSync(file,executable?0o755:0o644);
  }
  let minimumMacOS='0.0';
  for(const target of seen){
   const commands=Tools.loadCommands(target,cpu);if(B.versionAtLeast(commands.minimumMacOS,minimumMacOS))minimumMacOS=commands.minimumMacOS;
  }
  // Sign nested code before the app's main executable seals its bundle.
  const main=path.join(files,executableRelative);
  const signingOrder=[...seen].filter(target=>!appRoot||target!==main).sort((a,b)=>b.split(path.sep).length-a.split(path.sep).length||a.localeCompare(b));
  for(const target of signingOrder)if(!shared.has(target))run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',target]);
  // Preserved shared imports retain their logical loader names. Copy only
  // finalized bytes; package layout later replaces these copies by exact aliases.
  for(const [alias,canonical]of aliases){
   if(fs.existsSync(alias)){if(Native.hashFile(alias)!==Native.hashFile(canonical))throw Error('Conflicting preserved dependency alias bytes.');}
   else{fs.mkdirSync(path.dirname(alias),{recursive:true});fs.copyFileSync(canonical,alias,fs.constants.COPYFILE_EXCL);}
   seen.add(alias);
  }
  if(appRoot)run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',path.join(files,path.basename(appRoot))]);
  // Descriptor hashes refer to the relocated, signed code in the package.
  for(const [relative,update] of Object.entries(jsonMetadata)) {
   B.relativeFile(relative);const file=path.join(files,relative);
   if(!relative.endsWith('.json')||!fs.statSync(file).isFile()||Tools.macho(file)||typeof update!=='function')throw Error('Metadata updates require an existing JSON descriptor.');
   const value=update(JSON.parse(fs.readFileSync(file,'utf8')),{files});
   fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
  }
  const inventory=B.fileInventory(files).map(relative=>{const target=path.join(files,relative),stat=fs.statSync(target),architectures=Tools.macho(target);return {path:relative,size:stat.size,sha256:Native.hashFile(target),mode:stat.mode&0o777,...(architectures?{architectures}:{})};});
  const manifest={schemaVersion:1,managerId:id,version,upstreamRevision,platform:'darwin',arch,minimumMacOS,executableRelative,files:inventory,
   dependencies:[...seen].map(file=>({file:path.relative(files,file).split(path.sep).join('/'),links:Tools.links(file,cpu).filter(link=>!Tools.libraryIds(file,cpu).includes(link))})),
   runtimeFiles,environmentRelative,...(capabilities?{capabilities}:{}),signature:{identity:'-',verified:true},
   provenance:Tools.publicProvenance({...provenance,sourceRevision:upstreamRevision,inputExecutableSha256:originals.get(executable)||Native.hashFile(executable),verifiedBuild:true})};
  await Source.validatePinnedSource(sourceRoot,upstreamRevision,{sourceScope});
  for(const [file,hash] of originals)if(Native.hashFile(file)!==hash)throw Error('Original build input changed while sealing.');
  B.validateManifest(manifest);
  fs.writeFileSync(path.join(payload,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  const declaration=await managerDeclaration({project:id,input:payload});
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
  return {project:id,version,arch,output};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
