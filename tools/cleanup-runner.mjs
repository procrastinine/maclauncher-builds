import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const inside=(file,root)=>file===root||file.startsWith(root===path.sep?root:root+path.sep);
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value&&!value.includes('\0');
const xcodeRoot=file=>/^\/Applications\/Xcode[^/]*\.app(?:\/|$)/.exec(file||'')?.[0].replace(/\/$/,'');
const caches=(home,platform='darwin')=>(platform==='darwin'?['Library/Caches/Homebrew','Library/Developer/Xcode/DerivedData','Library/Caches/pip','.cache/pip','.npm/_cacache']:['.cache/pip','.npm/_cacache']).map(name=>path.join(home,name));
const linuxSdks=new Map([['/usr/share/dotnet',/^(?:dotnet|aspnet)(?:$|[-@])/],['/opt/ghc',/^(?:ghc|ghcup|haskell|cabal|stack)(?:$|[-@])/],['/usr/local/.ghcup',/^(?:ghc|ghcup|haskell|cabal|stack)(?:$|[-@])/],['/usr/local/swift',/^(?:swift|sourcekit)(?:$|[-@])/],['/usr/local/lib/android',/^(?:android|ndk|sdkmanager|adb|emulator)(?:$|[-@])/]]);
const read=(program,args,env=process.env)=>execFileSync(program,args,{env,encoding:'utf8',timeout:60000,maxBuffer:4<<20}).trim();
export const canonicalDirectory=file=>fs.realpathSync(file);

/** Applying cleanup is restricted to GitHub's disposable hosted machines. */
export function assertHostedApply(environment=process.env,platform=process.platform){
 if(environment.GITHUB_ACTIONS!=='true'||environment.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Cleanup --apply requires GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted.');
 if(!['darwin','linux'].includes(platform))throw Error('Cleanup --apply supports GitHub-hosted macOS and Linux runners.');
}
function allowed(entry,{developerDirectory,homeDirectory,platform='darwin'}){
 if(!absolute(entry.path)||entry.isSymbolicLink||entry.realPath!==entry.path||entry.isDirectory!==true)return false;
 if(platform==='linux')return entry.kind==='linux-sdk'&&linuxSdks.has(entry.path)||entry.kind==='cache'&&caches(homeDirectory,'linux').includes(entry.path);
 if(entry.kind==='xcode')return /^\/Applications\/Xcode[^/]*\.app$/.test(entry.path);
 if(entry.kind==='clt')return entry.path==='/Library/Developer/CommandLineTools';
 if(entry.kind==='cache')return caches(homeDirectory).includes(entry.path);
 if(entry.kind==='platform-sdk'){
  const selected=xcodeRoot(developerDirectory);if(!selected)return false;
  const prefix=selected+'/Contents/Developer/Platforms/';
  if(!entry.path.startsWith(prefix))return false;
  const relative=entry.path.slice(prefix.length),match=/^([^/]+\.platform)\/Developer\/SDKs\/[^/]+\.sdk$/.exec(relative);
  return Boolean(match&&match[1]!=='MacOSX.platform');
 }
 return false;
}

/** Select bounded cleanup targets from an inventory without changing the filesystem. */
export function planRunnerCleanup({developerDirectory,sdkRoot=null,homeDirectory,entries,activePaths=[],simulatorRuntimes=[],platform='darwin',tools=[]}){
 if(!['darwin','linux'].includes(platform)||platform==='darwin'&&!absolute(developerDirectory)||!absolute(homeDirectory)||sdkRoot!==null&&!absolute(sdkRoot)||!Array.isArray(entries))throw Error('Cleanup planning needs canonical absolute developer, SDK and home paths and an inventory.');
 const protectedPaths=[...(developerDirectory?[developerDirectory]:[]),...(sdkRoot?[sdkRoot]:[]),...activePaths.filter(absolute)],actions=[],kept=[];
 for(const entry of entries){
  if(!allowed(entry,{developerDirectory,homeDirectory,platform})){kept.push({...entry,reason:'outside the cleanup target set or a symbolic link'});continue;}
  if(entry.kind==='linux-sdk'&&tools.some(name=>linuxSdks.get(entry.path)?.test(name))){kept.push({...entry,reason:'matches a declared build tool'});continue;}
  if(protectedPaths.some(file=>inside(file,entry.path))||sdkRoot&&inside(entry.path,sdkRoot)){kept.push({...entry,reason:'contains a selected SDK or active tool'});continue;}
  actions.push({kind:entry.kind,path:entry.path});
 }
 const simulatorTargets=new Map();
 for(const runtime of simulatorRuntimes){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runtime.identifier||'')||runtime.deletable===false)continue;
  if(sdkRoot&&[runtime.path,runtime.bundlePath,runtime.mountPath].filter(absolute).some(file=>inside(file,sdkRoot)||inside(sdkRoot,file)))continue;
  let target=[runtime.path,runtime.bundlePath,runtime.mountPath].find(absolute);
  if(target){try{target=canonicalDirectory(target);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(simulatorTargets.has(target)){kept.push({kind:'simulator-runtime',path:target,identifier:runtime.identifier,reason:'shares a canonical physical target with simulator '+simulatorTargets.get(target)});continue;}
   simulatorTargets.set(target,runtime.identifier);
  }
  actions.unshift({kind:'simulator-runtime',identifier:runtime.identifier,...(target?{measurementPath:target}:{}),...(Number.isSafeInteger(runtime.sizeBytes)?{reportedSizeBytes:runtime.sizeBytes}:{})});
 }
 return {platform,developerDirectory,sdkRoot,homeDirectory,protectedPaths,actions,kept};
}
function inventoryEntry(file,kind){
 const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)return null;
 let realPath=null;try{realPath=fs.realpathSync(file);}catch(error){if(!stat.isSymbolicLink())throw error;}
 return {kind,path:file,realPath,isSymbolicLink:stat.isSymbolicLink(),isDirectory:stat.isDirectory()};
}
export function inspectMacRunner({developerDirectory,sdkRoot=null,homeDirectory=os.homedir(),activePaths=[]}){
 developerDirectory=canonicalDirectory(developerDirectory);sdkRoot=sdkRoot?canonicalDirectory(sdkRoot):null;homeDirectory=canonicalDirectory(homeDirectory);
 const entries=[],add=(file,kind)=>{const entry=inventoryEntry(file,kind);if(entry)entries.push(entry);};
 for(const name of fs.readdirSync('/Applications'))if(/^Xcode[^/]*\.app$/.test(name))add(path.join('/Applications',name),'xcode');
 const selected=xcodeRoot(developerDirectory),platforms=selected&&path.join(selected,'Contents/Developer/Platforms');
 if(platforms&&fs.existsSync(platforms))for(const name of fs.readdirSync(platforms)){
  if(name==='MacOSX.platform'||!name.endsWith('.platform'))continue;
  const directory=path.join(platforms,name,'Developer/SDKs');if(fs.existsSync(directory))for(const sdk of fs.readdirSync(directory))if(sdk.endsWith('.sdk'))add(path.join(directory,sdk),'platform-sdk');
 }
 add('/Library/Developer/CommandLineTools','clt');for(const file of caches(homeDirectory))add(file,'cache');
 const canonicalActive=activePaths.filter(file=>absolute(file)&&fs.existsSync(file)).map(canonicalDirectory);
 return {developerDirectory,sdkRoot,homeDirectory,entries,activePaths:canonicalActive};
}
export function inspectLinuxRunner({homeDirectory=os.homedir(),activePaths=[],sdkRoot=null}){
 homeDirectory=canonicalDirectory(homeDirectory);const entries=[];
 for(const [file]of linuxSdks){const entry=inventoryEntry(file,'linux-sdk');if(entry)entries.push(entry);}
 for(const file of caches(homeDirectory,'linux')){const entry=inventoryEntry(file,'cache');if(entry)entries.push(entry);}
 return {platform:'linux',developerDirectory:null,sdkRoot:sdkRoot?canonicalDirectory(sdkRoot):null,homeDirectory,entries,activePaths:activePaths.filter(file=>absolute(file)&&fs.existsSync(file)).map(canonicalDirectory)};
}
export function simulatorInventory(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Unexpected simulator runtime inventory.');
 return Object.entries(value).filter(([identifier,row])=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(identifier)&&row&&typeof row==='object').map(([identifier,row])=>({identifier,deletable:row.deletable,path:row.path||row.imagePath||row.bundlePath,bundlePath:row.bundlePath,mountPath:row.mountPath,sizeBytes:row.sizeBytes}));
}
function allocatedBytes(file){
 try{const output=read('/usr/bin/du',['-xsk',file]);return Number(/^\s*(\d+)/.exec(output)?.[1])*1024;}catch{return null;}
}
export function filesystemSpace(file){
 const value=fs.statfsSync(file,{bigint:true});return {path:fs.realpathSync(file),blockSizeBytes:value.bsize.toString(),totalBytes:(value.blocks*value.bsize).toString(),freeBytes:(value.bfree*value.bsize).toString(),availableBytes:(value.bavail*value.bsize).toString()};
}
function assertPhysicalTarget(action,plan){
 const entry=inventoryEntry(action.path,action.kind);
 if(!entry||!allowed(entry,plan)||(plan.protectedPaths.some(file=>inside(file,entry.path))||plan.sdkRoot&&inside(entry.path,plan.sdkRoot)))throw Error('Cleanup target changed or contains an active SDK/tool: '+action.path);
}

/** A missing target is accepted only after this invocation verified its earlier removal. */
export function applyCleanupAction(action,plan,{environment=process.env,platform=process.platform,completed=[],execute=read,exists=fs.existsSync}={}){
 assertHostedApply(environment,platform);
 if(action.kind==='simulator-runtime'&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(action.identifier||''))throw Error('Cleanup simulator identifier changed.');
 const target=action.measurementPath||action.path,prior=target&&completed.find(row=>inside(target,row.target));
 if(action.kind==='simulator-runtime'&&prior&&!exists(target))return {status:'already-removed',removedBy:prior.identifier||prior.target};
 if(action.kind==='simulator-runtime'){
  execute('/usr/bin/xcrun',['simctl','runtime','delete',action.identifier],environment);
 }else{assertPhysicalTarget(action,plan);execute('/usr/bin/sudo',['-n','/bin/rm','-rf','--',action.path],environment);}
 if(target&&!exists(target))completed.push({target,identifier:action.identifier});
 return {status:'removed'};
}

export function cleanupOptions(args,environment=process.env){
 let apply=false,modeSelected=false,tools=(environment.TOOLS||'').split(/\s+/).filter(Boolean),toolsSelected=false;
 for(let index=0;index<args.length;index++){
  const flag=args[index];
  if(['--apply','--dry-run'].includes(flag)){if(modeSelected)throw Error('Select one cleanup mode.');apply=flag==='--apply';modeSelected=true;}
  else if(flag==='--tools'&&!toolsSelected&&args[index+1]!==undefined){tools=args[++index].split(/\s+/).filter(Boolean);toolsSelected=true;}
  else throw Error('Use --dry-run (default) or --apply, with optional --tools "formula names".');
 }
 if(tools.some(name=>!(/^[a-z0-9][a-z0-9@+._-]{0,63}$/).test(name)))throw Error('Cleanup tool names must be declared build-tool names.');
 return {apply,tools};
}
export function main(args){
 const {apply,tools}=cleanupOptions(args);if(apply)assertHostedApply();
 const measured=process.env.RUNNER_TEMP||process.cwd(),before=filesystemSpace(measured);
 if(!['darwin','linux'].includes(process.platform)){const result={mode:'dry-run',before,after:filesystemSpace(measured),actions:[],note:'This platform has no cleanup targets.'};console.log(JSON.stringify(result,null,2));return result;}
 const developerDirectory=process.platform==='darwin'?(process.env.DEVELOPER_DIR||read('/usr/bin/xcode-select',['-p'])):null;
 const toolEnv={...process.env,...(developerDirectory?{DEVELOPER_DIR:developerDirectory}:{})};
 const warnings=[],declaredTools=[];
 for(const name of tools){try{const prefix=process.platform==='darwin'?read('brew',['--prefix',name]):read('/usr/bin/which',[name]);if(fs.existsSync(prefix))declaredTools.push(prefix);}catch{warnings.push('Declared tool is not installed before cleanup: '+name);}}
 const activePaths=[process.execPath,...declaredTools,...['JAVA_HOME','RUSTUP_HOME','CARGO_HOME','RUNNER_TOOL_CACHE','AGENT_TOOLSDIRECTORY','SDKROOT','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_NDK_HOME','ANDROID_NDK_ROOT','DOTNET_ROOT','DOTNET_ROOT_X64','DOTNET_ROOT_ARM64','SWIFT_ROOT'].map(key=>process.env[key]).filter(Boolean)];
 for(const key of ['CC','CXX'])if(process.env[key]){try{activePaths.push(absolute(process.env[key])?process.env[key]:read('/usr/bin/which',[process.env[key]]));}catch{warnings.push('The explicit '+key+' compiler path could not be resolved.');}}
 const inspection=process.platform==='darwin'?inspectMacRunner({developerDirectory,sdkRoot:process.env.SDKROOT||null,activePaths}):inspectLinuxRunner({sdkRoot:process.env.SDKROOT||null,activePaths});
 let runtimes=[];
 if(process.platform==='darwin')try{runtimes=simulatorInventory(JSON.parse(read('/usr/bin/xcrun',['simctl','runtime','list','--json'],toolEnv)));}catch(error){warnings.push('Simulator inventory unavailable: '+error.message.split('\n')[0]);}
 const plan=planRunnerCleanup({...inspection,tools,simulatorRuntimes:runtimes}),actions=[],completed=[];
 console.log(JSON.stringify({phase:'before',mode:apply?'apply':'dry-run',space:before,developerDirectory:plan.developerDirectory,sdkRoot:plan.sdkRoot}));
 for(const action of plan.actions){
  const record={...action,allocatedBytes:action.path||action.measurementPath?allocatedBytes(action.path||action.measurementPath):null,status:'planned'};
  if(apply){
   try{
    Object.assign(record,applyCleanupAction(action,plan,{environment:toolEnv,completed}));
   }catch(error){record.status='failed';record.error=error.message.split('\n')[0];}
  }
  actions.push(record);
 }
 const after=filesystemSpace(measured),result={declaredTools:tools,mode:apply?'apply':'dry-run',before,after,availableDeltaBytes:(BigInt(after.availableBytes)-BigInt(before.availableBytes)).toString(),actions,kept:plan.kept.map(({path,reason})=>({path,reason})),warnings};
 console.log(JSON.stringify(result,null,2));if(actions.some(action=>action.status==='failed'))process.exitCode=1;return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
