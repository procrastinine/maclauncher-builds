import './producer-environment.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {retryNetwork} from './download.mjs';

/** Package-manager locks. A build declares, as `locks`, the Cargo.lock, go.sum, NuGet packages.lock.json and
 *  SwiftPM Package.resolved files its compile reads; `build-runtime --prepare` fetches what each one names into one cache per tool,
 *  and the compile reads that cache offline. Each lock is fetched from the lock alone, through a generated
 *  manifest that requires every locked package, so a recipe may compose its own manifest at compile time. */
export const LOCK_TOOLS=['cargo','go','nuget','swiftpm'];
/** The lock caches persist per user. On macOS they live in the user's Caches folder: the daily temporary-folder cleanup deletes files
 *  there that have not been read for three days and keeps directories and newer files, which leaves unpacked crates empty behind
 *  cargo's completion markers. Elsewhere they live in the temporary folder. */
export const lockRoot=(platform=process.platform)=>platform==='darwin'?path.join(os.homedir(),'Library','Caches','maclauncher-build-locks'):path.join(os.tmpdir(),'maclauncher-build-locks');
export const lockCache=tool=>{if(!LOCK_TOOLS.includes(tool))throw Error('Unknown lock tool: '+tool);return path.join(lockRoot(),tool);};
const execute=(command,args,options)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity,timeout:1800000,...options});
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const quote=value=>JSON.stringify(String(value));

/** The [[package]] tables of a version 3 or 4 Cargo.lock. */
export function cargoLockPackages(text){
 const version=/^version = (\d+)$/m.exec(text)?.[1];
 if(!['3','4'].includes(version))throw Error('the lock is not a version 3 or 4 Cargo.lock');
 return text.split(/^\[\[package\]\]$/m).slice(1).map(block=>{
  const row={};for(const [,key,value] of block.matchAll(/^(name|version|source|checksum) = "([^"]*)"$/gm))row[key]=value;
  if(!row.name||!row.version)throw Error('a [[package]] table has no name or version');
  return row;
 });
}
/** The generated manifest requiring every registry and Git package of a Cargo.lock at its locked version. */
export function cargoLockManifest(text){
 const rows=cargoLockPackages(text).filter(row=>row.source).map((row,index)=>{
  const key='locked-'+index;
  if(row.source==='registry+https://github.com/rust-lang/crates.io-index'){
   if(!/^[a-f0-9]{64}$/.test(row.checksum||''))throw Error(row.name+' '+row.version+' has no checksum');
   return key+' = { package = '+quote(row.name)+', version = '+quote('='+row.version.split('+')[0])+', default-features = false }';
  }
  const git=/^git\+(https:\/\/[^?#]+)(?:\?(rev|tag|branch)=([^#]+))?#([a-f0-9]{40})$/.exec(row.source);
  if(!git)throw Error(row.name+' '+row.version+' comes from an unsupported source '+row.source);
  return key+' = { package = '+quote(row.name)+', git = '+quote(git[1])+(git[2]?', '+git[2]+' = '+quote(decodeURIComponent(git[3])):'')+', default-features = false }';
 });
 return '[package]\nname = "maclauncher-locked-packages"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[lib]\npath = "lib.rs"\n\n[dependencies]\n'+rows.join('\n')+'\n';
}
/** The pinned Git repositories of a version 2 or 3 SwiftPM Package.resolved. */
export function swiftResolvedPins(text){
 const lock=JSON.parse(text);
 if(![2,3].includes(lock?.version)||!Array.isArray(lock.pins)||!lock.pins.length)throw Error('the lock is not a version 2 or 3 Package.resolved');
 return lock.pins.map(pin=>{
  if(pin?.kind!=='remoteSourceControl'||!/^https:\/\/[^\s]+$/.test(pin.location||'')||!/^[a-f0-9]{40}$/.test(pin.state?.revision||''))throw Error((pin?.identity||'a pin')+' is not a remote Git repository at an exact revision');
  return {location:pin.location,revision:pin.state.revision,...(typeof pin.state.version==='string'?{tag:pin.state.version}:{})};
 });
}
// Each repository a SwiftPM lock reaches has one bare repository in the cache, named by its address.
const swiftMirrors=()=>path.join(lockCache('swiftpm'),'mirrors.json');
const readMirrors=()=>fs.existsSync(swiftMirrors())?JSON.parse(fs.readFileSync(swiftMirrors(),'utf8')):{};
/** The NuGet packages of a packages.lock.json, with their frameworks, runtimes and direct references. */
export function nugetLockProject(text){
 const lock=JSON.parse(text);
 if(lock?.version!==1&&lock?.version!==2||!lock.dependencies||typeof lock.dependencies!=='object')throw Error('the lock is not a NuGet packages.lock.json');
 const frameworks=[],runtimes=new Set(),references=new Map();
 for(const [group,packages] of Object.entries(lock.dependencies)){
  const [framework,runtime]=group.split('/');if(!/^net[0-9.]+$/.test(framework))throw Error('the framework '+group+' is not a .NET target framework');
  if(runtime)runtimes.add(runtime);else frameworks.push(framework);
  for(const [name,row] of Object.entries(packages)){
   if(row.type==='Project'||row.type==='CentralTransitive')throw Error(name+' is a '+row.type+' entry, which a lock without its project cannot restore');
   if(!/^[A-Za-z0-9_.-]+$/.test(name)||typeof row.resolved!=='string'||typeof row.contentHash!=='string')throw Error(name+' has no resolved version or content hash');
   if(row.type==='Direct'&&!runtime)references.set(framework+'\0'+name,{framework,name,requested:row.requested});
  }
 }
 if(!frameworks.length)throw Error('the lock names no target framework');
 const items=frameworks.map(framework=>'  <ItemGroup Condition="\'$(TargetFramework)\'==\''+framework+'\'">\n'+[...references.values()].filter(row=>row.framework===framework).map(row=>'    <PackageReference Include="'+row.name+'" Version="'+row.requested+'" />\n').join('')+'  </ItemGroup>\n').join('');
 return '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFrameworks>'+frameworks.join(';')+'</TargetFrameworks>\n'+(runtimes.size?'    <RuntimeIdentifiers>'+[...runtimes].join(';')+'</RuntimeIdentifiers>\n':'')+'    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>\n  </PropertyGroup>\n'+items+'</Project>\n';
}

// A generated manifest lives under the tool's cache, in a directory named by the lock's digest.
function scratch(tool,text){
 const directory=path.join(path.dirname(lockCache(tool)),'manifests',tool+'-'+digest(text));
 fs.rmSync(directory,{recursive:true,force:true});fs.mkdirSync(directory,{recursive:true});return directory;
}
const RESOLVERS={
 cargo({file,text,env,run}){
  const directory=scratch('cargo',text),home=lockCache('cargo');
  fs.writeFileSync(path.join(directory,'Cargo.toml'),cargoLockManifest(text));fs.writeFileSync(path.join(directory,'lib.rs'),'');
  // The declared lock is the previous resolve, so every package keeps its locked version and checksum.
  fs.writeFileSync(path.join(directory,'Cargo.lock'),text);
  // The build's own toolchain (RUSTUP_TOOLCHAIN from prepare) names the cache directories the compile reads.
  run('cargo',['fetch','--manifest-path',path.join(directory,'Cargo.toml')],{env:{...env,CARGO_HOME:home,CARGO_NET_OFFLINE:'false'}});
  const caches=fs.existsSync(path.join(home,'registry/cache'))?fs.readdirSync(path.join(home,'registry/cache')).map(name=>path.join(home,'registry/cache',name)):[];
  for(const row of cargoLockPackages(text).filter(row=>row.checksum)){
   const crate=caches.map(cache=>path.join(cache,row.name+'-'+row.version+'.crate')).find(candidate=>fs.existsSync(candidate));
   if(!crate)throw Error(row.name+' '+row.version+' was not fetched');
   if(digest(fs.readFileSync(crate))!==row.checksum)throw Error(row.name+' '+row.version+' differs from its locked checksum');
  }
 },
 go({file,text,env,run}){
  const directory=scratch('go',text),manifest=path.join(path.dirname(file),'go.mod');
  if(!fs.existsSync(manifest))throw Error('go.mod is missing beside the lock');
  fs.copyFileSync(manifest,path.join(directory,'go.mod'));fs.writeFileSync(path.join(directory,'go.sum'),text);
  // go prints one JSON object per module, each opening at the start of a line.
  const failed=output=>String(output||'').trim().split(/\n(?=\{)/).filter(Boolean).map(chunk=>JSON.parse(chunk)).filter(module=>module.Error);
  try{run('go',['mod','download','-json'],{cwd:directory,env:{...env,GOMODCACHE:lockCache('go'),GOFLAGS:'-mod=readonly',GOTOOLCHAIN:'local',GOWORK:'off'}});}
  catch(error){const modules=failed(error.stdout);if(modules.length)throw Error(modules.map(module=>module.Path+' '+module.Version+': '+module.Error).join('; '));throw error;}
  // go records a missing checksum in the copy; the declared lock must already hold every one.
  const added=fs.readFileSync(path.join(directory,'go.sum'),'utf8').split('\n').filter(line=>line&&!text.split('\n').includes(line));
  if(added.length)throw Error('the lock has no checksum for '+[...new Set(added.map(line=>line.split(' ').slice(0,2).join(' ')))].join(', '));
 },
 swiftpm({text,env,run}){
  // Each pinned revision and its version tag, then, through the same repositories, the submodule commits its tree
  // records, which SwiftPM checks out with the package.
  const mirrors=readMirrors(),pending=swiftResolvedPins(text),seen=new Set();
  while(pending.length){
   const {location,revision,tag}=pending.shift();if(seen.has(location+'#'+revision))continue;seen.add(location+'#'+revision);
   const mirror=mirrors[location]||path.join(lockCache('swiftpm'),digest(location).slice(0,24)+'.git'),git=args=>run('git',['-C',mirror,...args],{env:{...env,GIT_TERMINAL_PROMPT:'0'}});
   if(!fs.existsSync(path.join(mirror,'HEAD')))run('git',['init','--quiet','--bare',mirror],{env});
   mirrors[location]=mirror;
   git(['fetch','--quiet','--no-tags',location,'+'+revision+':refs/locked/'+revision,...(tag?['+refs/tags/'+tag+':refs/tags/'+tag]:[])]);
   if(tag&&git(['rev-parse','refs/tags/'+tag+'^{commit}']).trim()!==revision)throw Error(location+' '+tag+' is not the locked revision '+revision);
   if(!git(['ls-tree',revision,'.gitmodules']).trim())continue;
   const modules={};
   for(const line of git(['config','--blob',revision+':.gitmodules','--get-regexp','^submodule\\..*\\.(path|url)$']).split('\n').filter(Boolean)){
    const [,name,key,value]=/^submodule\.(.+)\.(path|url) (.*)$/.exec(line);(modules[name]??={})[key]=value;
   }
   for(const {path:entry,url} of Object.values(modules)){
    const commit=/^160000 commit ([a-f0-9]{40})\t/.exec(git(['ls-tree',revision,'--',entry]))?.[1];
    if(!commit||!url)throw Error(location+' '+revision+' has no submodule commit at '+entry);
    // A relative submodule address is relative to the repository's own address, as Git resolves it.
    pending.push({location:/^\.\.?\//.test(url)?new URL(url,location.replace(/\/?$/,'/')).href.replace(/\/$/,''):url,revision:commit});
   }
  }
  fs.writeFileSync(swiftMirrors(),JSON.stringify(mirrors,null,1)+'\n');
 },
 nuget({file,text,env,run}){
  const directory=scratch('nuget',text),project=path.join(directory,'locked-packages.csproj');
  fs.writeFileSync(project,nugetLockProject(text));
  // Locked mode checks each package's content hash against the lock.
  run('dotnet',['restore',project,'--locked-mode','--lock-file-path',file,'--packages',lockCache('nuget'),'-maxCpuCount:1'],{env:{...env,DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1',DOTNET_CLI_HOME:path.join(directory,'home'),NUGET_PACKAGES:lockCache('nuget')}});
 }
};
// A tool's error lines say what it rejected; MSBuild's leading project path is dropped.
const toolMessage=error=>{
 const lines=[error.stdout,error.stderr].join('\n').split('\n').map(line=>line.trim().replace(/^.*?\s:\s(?=error\b)/,'')).filter(Boolean);
 const errors=lines.filter(line=>/^error\b/.test(line)),named=lines.filter(line=>line.includes('`')&&!/^warning\b/.test(line));
 return [...new Set(errors.length?errors:named.length?named:lines.slice(-3))].join(' ');
};
/** Fetch every package a build's declared locks name into the shared lock caches. */
export function resolveLocks({project,locks=[],directory,env=process.env,run=(command,args,options)=>retryNetwork(()=>execute(command,args,options))}){
 for(const {tool,file:relative} of locks){
  const file=path.join(directory,relative);
  try{
   if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile())throw Error('the file is missing');
   fs.mkdirSync(lockCache(tool),{recursive:true});
   RESOLVERS[tool]({file,text:fs.readFileSync(file,'utf8'),env,run});
  }catch(error){throw Error(project+': the '+tool+' lock '+relative+' does not resolve: '+(error.stdout||error.stderr?toolMessage(error):error.message),{cause:error});}
 }
 return locks.map(lock=>({...lock,cache:lockCache(lock.tool)}));
}
/** The environment through which a compile reads each declared tool's locked packages, with no network access. */
export const LOCKED_ENVIRONMENT={
 cargo:()=>({CARGO_HOME:lockCache('cargo'),CARGO_NET_OFFLINE:'true'}),
 go:()=>({GOMODCACHE:lockCache('go'),GOPROXY:'off',GOFLAGS:'-mod=readonly'}),
 nuget:()=>({NUGET_PACKAGES:lockCache('nuget')}),
 // Git, which SwiftPM runs, reads each locked repository from its cached bare repository and reaches no other address.
 swiftpm:()=>{
  const first=Number(process.env.GIT_CONFIG_COUNT)||0,rules=Object.entries(readMirrors());
  return {GIT_ALLOW_PROTOCOL:'file',GIT_CONFIG_COUNT:String(first+rules.length),
   ...Object.fromEntries(rules.flatMap(([location,mirror],index)=>[['GIT_CONFIG_KEY_'+(first+index),'url.'+mirror+'.insteadOf'],['GIT_CONFIG_VALUE_'+(first+index),location]]))};
 }
};
export function lockedEnvironment(build){return Object.assign({},...[...new Set((build.locks||[]).map(lock=>lock.tool))].map(tool=>LOCKED_ENVIRONMENT[tool]()));}
