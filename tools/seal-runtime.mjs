// Package a freshly built executable and its non-system dependency closure.
// Recipes supply public sources and build products; no launcher registry or
// previously reviewed local executable checksum is required.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {managerDeclaration} from './release-runtime.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native.js');
const Source=require('../producers/maclauncher/src/modules/shared/runtime/pinned-native-build.js');
const Tools=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const system=value=>value.startsWith('/usr/lib/')||value.startsWith('/System/Library/');
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:120000,maxBuffer:16<<20});

export async function sealRuntime({project:id,version:selectedVersion,arch,executable,sourceRoot,sourceScope,upstreamRevision,output,executableRelative,appRoot,payloads=[],notices=[],extraLibraries=[],runtimeFiles={},environmentRelative={},jsonMetadata={},capabilities,maximumMacOS='13.0',provenance={},directory=path.resolve(import.meta.dirname,'..')}) {
 const project=resolveProject(id,directory),build=buildRecord(project,selectedVersion),version=build.version,cpu=arch==='x64'?'x86_64':arch;
 if(!version||!['arm64','x64'].includes(arch)||!build.architectures.includes(arch)||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(executable||'')||!path.isAbsolute(sourceRoot||'')||!project.upstreams.some(pin=>pin.revision===upstreamRevision)||!notices.length)
  throw Error('Sealing needs a registered build, target CPU, pinned public source, license notices and a new absolute output directory.');
 await Source.validatePinnedSource(sourceRoot,upstreamRevision,{sourceScope});
 executable=fs.realpathSync(executable);executableRelative??=appRoot?path.basename(appRoot)+'/Contents/MacOS/'+path.basename(executable):'bin/'+path.basename(executable);B.relativeFile(executableRelative);
 const payload=path.join(output,'payload'),files=path.join(payload,'files'),originals=new Map(),targets=new Map(),sources=new Map(),licenseRows=[];
 const copy=(source,relative)=>{B.relativeFile(relative);const target=path.join(files,relative);Tools.copyTree(source,target);return target;};
 fs.mkdirSync(files,{recursive:true});
 try {
  copy(appRoot||executable,appRoot?path.basename(appRoot):executableRelative);
  for(const entry of payloads)copy(entry.source,entry.relative);
  for(const [index,notice] of notices.entries()){
   const relative='licenses/upstream/'+index+'-'+path.basename(notice.file);copy(notice.file,relative);
   const {file,...metadata}=notice;licenseRows.push({...metadata,path:relative});
  }
  const roots=[{source:appRoot||executable,relative:appRoot?path.basename(appRoot):executableRelative},...payloads];
  for(const relative of B.fileInventory(files)){
   const target=path.join(files,relative);if(!Tools.macho(target))continue;
   const entry=roots.find(entry=>relative===entry.relative||relative.startsWith(entry.relative+'/'));
   if(!entry)throw Error('Native license input is not a production binary.');
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
  const queue=[...sources.keys()],seen=new Set(),noticeRoots=new Set(),inherited=Tools.loadCommands(executable,cpu).rpaths;
  const receipts=path.join(output,'dependency-receipts');fs.mkdirSync(receipts);
  try {for(let i=0;i<queue.length;i++){
   const target=queue[i];if(seen.has(target))continue;seen.add(target);const source=sources.get(target);
   Tools.thinStagedMachO(target,files,cpu,run);
   Tools.addDependencyNotices(source,files,licenseRows,noticeRoots,receipts);
   const commands=Tools.loadCommands(source,cpu),ids=Tools.libraryIds(source,cpu);
   for(const link of Tools.links(source,cpu)){
    if(system(link)||ids.includes(link))continue;
    const resolved=Tools.resolveLink(link,source,executable,[...commands.rpaths,...inherited],cpu),dependency=addLibrary(resolved);
    run('/usr/bin/install_name_tool',['-change',link,'@loader_path/'+path.relative(path.dirname(target),dependency).split(path.sep).join('/'),target]);queue.push(dependency);
   }
   for(const rpath of new Set(commands.rpaths.filter(value=>path.isAbsolute(value)&&!system(value))))run('/usr/bin/install_name_tool',['-delete_rpath',rpath,target]);
   if(ids.length)run('/usr/bin/install_name_tool',['-id','@rpath/'+path.basename(target),target]);
  }}finally{fs.rmSync(receipts,{recursive:true,force:true});}
  // Upstream source and bottles may use read-only modes; package files are owned copies.
  for(const relative of B.fileInventory(files)){
   const file=path.join(files,relative),executable=Tools.macho(file)||Boolean(fs.statSync(file).mode&0o111);
   fs.chmodSync(file,executable?0o755:0o644);
  }
  let minimumMacOS='0.0';
  for(const target of seen){
   if(Tools.macho(target)?.join()!==cpu)throw Error('Dependency has the wrong CPU: '+path.basename(target));
   const commands=Tools.loadCommands(target,cpu);if(B.versionAtLeast(commands.minimumMacOS,minimumMacOS))minimumMacOS=commands.minimumMacOS;
  }
  if(!B.versionAtLeast(maximumMacOS,minimumMacOS))throw Error('Dependency closure requires macOS '+minimumMacOS+', above '+maximumMacOS+'.');
  // Sign nested code before the app's main executable seals its bundle.
  const main=path.join(files,executableRelative);
  const signingOrder=[...seen].filter(target=>!appRoot||target!==main).sort((a,b)=>b.split(path.sep).length-a.split(path.sep).length||a.localeCompare(b));
  for(const target of signingOrder)run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',target]);
  if(appRoot)run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',path.join(files,path.basename(appRoot))]);
  for(const target of seen){
   run('/usr/bin/codesign',['--verify','--strict',target]);
   const ids=Tools.libraryIds(target,cpu),commands=Tools.loadCommands(target,cpu);
   for(const link of Tools.links(target,cpu).filter(link=>!ids.includes(link)&&!system(link))){
    const resolved=Tools.resolveLink(link,target,path.join(files,executableRelative),commands.rpaths,cpu);
    if(!resolved.startsWith(files+path.sep))throw Error('Sealed dependency escapes the package.');
   }
  }
  // Descriptor hashes refer to the relocated, signed code in the package.
  const signedHashes=new Map([...seen].map(file=>[file,Native.hashFile(file)]));
  for(const [relative,update] of Object.entries(jsonMetadata)) {
   B.relativeFile(relative);const file=path.join(files,relative);
   if(!relative.endsWith('.json')||!fs.statSync(file).isFile()||Tools.macho(file)||typeof update!=='function')throw Error('Metadata updates require an existing JSON descriptor.');
   const value=update(JSON.parse(fs.readFileSync(file,'utf8')),{files});
   fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
  }
  for(const [file,hash] of signedHashes)if(Native.hashFile(file)!==hash)throw Error('Metadata update changed signed native code.');
  if(Object.keys(jsonMetadata).length)for(const file of seen)run('/usr/bin/codesign',['--verify','--strict',file]);
  const inventory=B.fileInventory(files).map(relative=>{const target=path.join(files,relative),stat=fs.statSync(target),architectures=Tools.macho(target);return {path:relative,size:stat.size,sha256:Native.hashFile(target),mode:stat.mode&0o777,...(architectures?{architectures}:{})};});
  const manifest={schemaVersion:1,managerId:id,version,upstreamRevision,platform:'darwin',arch,minimumMacOS,executableRelative,files:inventory,
   dependencies:[...seen].map(file=>({file:path.relative(files,file).split(path.sep).join('/'),links:Tools.links(file,cpu).filter(link=>!Tools.libraryIds(file,cpu).includes(link))})),
   notices:licenseRows,runtimeFiles,environmentRelative,...(capabilities?{capabilities}:{}),signature:{identity:'-',verified:true},
   provenance:Tools.publicProvenance({...provenance,sourceRevision:upstreamRevision,inputExecutableSha256:originals.get(executable)||Native.hashFile(executable),verifiedBuild:true})};
  B.validateManifest(manifest);B.verifyPayload(files,manifest);
  await Source.validatePinnedSource(sourceRoot,upstreamRevision,{sourceScope});
  for(const [file,hash] of originals)if(Native.hashFile(file)!==hash)throw Error('Original build input changed while sealing.');
  fs.writeFileSync(path.join(payload,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  const declaration=await managerDeclaration({project:id,input:payload});
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
  return {project:id,version,arch,output};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
