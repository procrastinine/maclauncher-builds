import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {helperPackage,sha} from './helper-package.mjs';
import {buildHelper} from './build-helper.mjs';
import {resolveProject} from '../lib/projects.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/maclauncher');
const Overlay=require('../producers/maclauncher/src/modules/love/runtime/luasteam-source-overlay.js'),Source=require('../producers/maclauncher/src/modules/shared/runtime/pinned-native-build.js');
const run=(tool,args)=>execFileSync(tool,args,{stdio:'pipe',timeout:120000});
export async function buildLuaSteam({project:id,arch,output,work,sourceDir=path.join(base,'src/external/luasteam'),sdkDir=path.join(base,'src/external/SteamworksSDK')}){
 const project=resolveProject(id,root,{resolvePins:false});
 if(id!=='love-luasteam'||arch!=='universal'||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Select love-luasteam, universal and new absolute output and work directories.');
 const luaDir=path.join(sourceDir,'luajit');await Source.validatePinnedSource(sourceDir,Overlay.SOURCE_REVISION);await Source.validatePinnedSource(sdkDir,Overlay.SDK_HEADERS_REVISION);await Source.validatePinnedSource(luaDir,Overlay.LUA_HEADERS_REVISION);
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});fs.mkdirSync(work,{recursive:true});
 try{
  const staged=path.join(work,'source'),source=Overlay.stageSource({roots:{luasteam:sourceDir,luajit:luaDir,steamSdk:sdkDir},destination:staged});
  const steam=buildHelper({project:'steam-api-helper',arch:'universal',output:path.join(work,'steam'),work:path.join(work,'steam-work')}),library=path.join(steam.output,'payload/libsteam_api.dylib');
  const slices=[];for(const cpu of ['arm64','x86_64']){
   const slice=path.join(work,cpu+'.so');run('/usr/bin/xcrun',['clang++',...Overlay.compilerArguments({sourceRoot:staged,architecture:cpu,steamLibraryPath:library,outputPath:slice}),'-ffile-prefix-map='+work+'=maclauncher-build']);
   run('/usr/bin/install_name_tool',['-change','@rpath/libsteam_api.dylib','@loader_path/libsteam_api.dylib',slice]);slices.push(slice);
  }
  const binary=path.join(payload,'luasteam.so');run('/usr/bin/lipo',['-create',...slices,'-output',binary]);fs.chmodSync(binary,0o755);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',binary]);run('/usr/bin/codesign',['--verify','--strict',binary]);
  const licenses=[['notices/LuaSteam-LICENSE','LuaSteam-MIT.txt','LuaSteam'],['notices/LuaJIT-COPYRIGHT','LuaJIT-MIT.txt','LuaJIT']];
  for(const [from,to] of licenses)fs.copyFileSync(path.join(staged,from),path.join(payload,to));fs.copyFileSync(path.join(base,'LICENSE'),path.join(payload,'MacLauncher-MIT.txt'));
  await Source.validatePinnedSource(sourceDir,Overlay.SOURCE_REVISION);await Source.validatePinnedSource(sdkDir,Overlay.SDK_HEADERS_REVISION);await Source.validatePinnedSource(luaDir,Overlay.LUA_HEADERS_REVISION);
  return helperPackage({id,version:project.build.version,arch,output,minimumMacOS:'13.0',sourceSha256:source.sourceTreeSha256,
   record:{upstreamVersion:'4.0.2',sourceRevision:Overlay.SOURCE_REVISION,luaHeadersRevision:Overlay.LUA_HEADERS_REVISION,sdkHeadersRevision:Overlay.SDK_HEADERS_REVISION,sdkVersion:Overlay.SDK_VERSION,hostLuaAbi:Overlay.HOST_LUA_ABI,abiProfile:'luasteam-4.0.2-sdk1.63-ml1',librarySha256:sha(binary),steamHelperVersion:steam.version,steamHelperLibrarySha256:sha(library)},
   notices:[...licenses.map(([,file,name])=>({name,license:'MIT',path:file})),{name:'MacLauncher LuaSteam integration',license:'MIT',path:'MacLauncher-MIT.txt'}]});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
export async function main(args){const o={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','arch','output','work'].includes(key)||!args[i+1]||Object.hasOwn(o,key))throw Error('Use --project, --arch, --output and --work.');o[key]=args[i+1];}return buildLuaSteam(o);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
