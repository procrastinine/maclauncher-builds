import './producer-environment.mjs';
import {addLicenses,includeLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {helperPackage,sha} from './helper-package.mjs';
import {buildHelper} from './build-helper.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/package-support');
const Overlay=require('../producers/package-support/src/modules/love/runtime/luasteam-source-overlay.js'),Source=require('../producers/package-support/src/modules/shared/runtime/pinned-native-build.js');
const run=(tool,args)=>execFileSync(tool,args,{maxBuffer:Infinity,stdio:'pipe',timeout:120000});
/** Compile LuaSteam for both CPUs against the Steam API helper. */
export async function compile({work,sourceDir=path.join(base,'src/external/luasteam'),sdkDir=path.join(base,'src/external/SteamworksSDK')}){
 const luaDir=path.join(sourceDir,'luajit');await Source.validatePinnedSource(sourceDir,Overlay.SOURCE_REVISION);
 const luaHeadersRevision=execFileSync('git',['-C',sourceDir,'rev-parse','HEAD:luajit'],{encoding:'utf8'}).trim();
 await Source.validatePinnedSource(sdkDir,Overlay.SDK_HEADERS_REVISION);await Source.validatePinnedSource(luaDir,luaHeadersRevision);
 fs.mkdirSync(work,{recursive:true});
 try{
  const staged=path.join(work,'source'),source=Overlay.stageSource({roots:{luasteam:sourceDir,luajit:luaDir,steamSdk:sdkDir},destination:staged,luaHeadersRevision});
  const steam=buildHelper({project:'steam-api-helper',arch:'universal',output:path.join(work,'steam'),work:path.join(work,'steam-work')}),library=path.join(steam.output,'payload/libsteam_api.dylib');
  const slices=[];for(const cpu of ['arm64','x86_64']){
   const slice=path.join(work,cpu+'.so');run('/usr/bin/xcrun',['clang++',...Overlay.compilerArguments({sourceRoot:staged,architecture:cpu,steamLibraryPath:library,outputPath:slice}),'-ffile-prefix-map='+work+'=maclauncher-build']);
   run('/usr/bin/install_name_tool',['-change','@rpath/libsteam_api.dylib','@loader_path/libsteam_api.dylib',slice]);slices.push(slice);
  }
  const binary=path.join(work,'luasteam.so');run('/usr/bin/lipo',['-create',...slices,'-output',binary]);fs.chmodSync(binary,0o755);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',binary]);
  return {sourceDir,sdkDir,luaDir,luaHeadersRevision,staged,source,binary};
 }catch(error){fs.rmSync(work,{recursive:true,force:true});throw error;}
}
/** Add the notices and package the compiled LuaSteam module. */
export async function assemble({project:id,arch,output,work,compiled:{sourceDir,sdkDir,luaDir,luaHeadersRevision,staged,source,binary}}){
 const project=resolveProject(id,root,{resolvePins:false}),payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 try{
  fs.copyFileSync(binary,path.join(payload,'luasteam.so'));fs.chmodSync(path.join(payload,'luasteam.so'),0o755);
  includeLicenses(payload,path.join(staged,'licenses'));addLicenses(payload,'MacLauncher',root);
  addLicenses(payload,'LuaSteam',sourceDir);addLicenses(payload,'LuaJIT',luaDir);
  await Source.validatePinnedSource(sourceDir,Overlay.SOURCE_REVISION);await Source.validatePinnedSource(sdkDir,Overlay.SDK_HEADERS_REVISION);await Source.validatePinnedSource(luaDir,luaHeadersRevision);
  return helperPackage({id,version:project.build.version,arch,output,minimumMacOS:'13.0',sourceSha256:source.sourceTreeSha256,record:{upstreamVersion:'4.0.2',sourceRevision:Overlay.SOURCE_REVISION,luaHeadersRevision:luaHeadersRevision,sdkHeadersRevision:Overlay.SDK_HEADERS_REVISION,sdkVersion:Overlay.SDK_VERSION,hostLuaAbi:Overlay.HOST_LUA_ABI,abiProfile:'luasteam-4.0.2-sdk1.63-ml1',librarySha256:sha(binary),steamHelperVersion:steam.version,steamHelperLibrarySha256:sha(library)}});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,{compile,assemble});
