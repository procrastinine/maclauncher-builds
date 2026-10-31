// GitHub build of an AliceSoft decompiler for one Mac CPU, sealed as a runtime
// manager output with the package declaration that release preparation reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolveProject,buildRecord} from '../../../lib/projects.mjs';
import {managerDeclaration} from '../../../tools/release-runtime.mjs';
import {recipeMain} from '../../../tools/build-source.mjs';
const require=createRequire(import.meta.url);
const Native=require('../src/modules/shared/runtime/local-native.js');
const B=require('../src/modules/shared/runtime/bundled-native.js');
const {macho,loadCommands,links,libraryIds}=require('./native-binary-tools.cjs');
const {buildManagedDecompiler}=require('../src/modules/alicesoft/decompiler-build.js');
const profiles=require('../src/modules/alicesoft/decompiler-profiles.json');
const external=path.resolve(import.meta.dirname,'../src/external');
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:60000});
const systemLink=value=>value.startsWith('/usr/lib/')||value.startsWith('/System/Library/');

export async function buildDecompiler({project,version:selectedVersion,arch,output,work=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'decompiler-')),'work'),dependencies}){
 const version=buildRecord(resolveProject(project,path.resolve(import.meta.dirname,'../../..'),{resolvePins:false}),selectedVersion).version;
 const profile=profiles.find(row=>row.managerId===project),release=profile?.releases.find(row=>row.version===version&&row.upstreamRevision===profile.upstreamRevision);
 if(!release)throw Error('The decompiler profiles have no release for '+project+'.');
 const cpu=arch==='x64'?'x86_64':'arm64',sourceDir=path.join(external,profile.repo),userDataDir=path.join(work,'user-data');
 // CMake reads its target CPU from this variable; a runner of the same CPU builds natively.
 const previous=process.env.CMAKE_OSX_ARCHITECTURES;process.env.CMAKE_OSX_ARCHITECTURES=cpu;
 let built;
 try{
  const manager={id:project,core:{normalizeVersion:value=>value,catalog:[{version:release.version,upstreamRevision:release.upstreamRevision}],
   getInstallDir:({version})=>path.join(userDataDir,project,version),resolveInstalled:()=>null,registerLocal:({runtimePath,verifiedBuild})=>({runtimePath,verifiedBuild})}};
  built=await buildManagedDecompiler({manager,version:release.version,sourceDir,userDataDir,dependencies});
 }finally{if(previous===undefined)delete process.env.CMAKE_OSX_ARCHITECTURES;else process.env.CMAKE_OSX_ARCHITECTURES=previous;}
 const payload=path.join(output,'payload'),files=path.join(payload,'files'),executableRelative='bin/'+profile.executable,license='licenses/upstream/0-COPYING';
 fs.mkdirSync(path.join(files,'bin'),{recursive:true});fs.mkdirSync(path.join(files,'licenses/upstream'),{recursive:true});
 const executable=path.join(files,executableRelative);
 fs.copyFileSync(built.runtimePath,executable,fs.constants.COPYFILE_EXCL);fs.chmodSync(executable,0o755);
 fs.copyFileSync(path.join(sourceDir,'COPYING'),path.join(files,license),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(files,license),0o644);
 if(JSON.stringify(macho(executable))!==JSON.stringify([cpu]))throw Error('The decompiler was built for a different CPU.');
 const ids=libraryIds(executable),linked=links(executable).filter(link=>!ids.includes(link));
 if(linked.some(link=>!systemLink(link)))throw Error('The decompiler links a library outside macOS.');
 const {minimumMacOS}=loadCommands(executable);
 if(!B.versionAtLeast('13.0',minimumMacOS))throw Error('The decompiler requires a macOS release above 13.0.');
 run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',executable]);run('/usr/bin/codesign',['--verify','--strict',executable]);
 const inventory=B.fileInventory(files).map(relative=>{const file=path.join(files,relative),stat=fs.statSync(file),architectures=macho(file);
  return {path:relative,size:stat.size,sha256:Native.hashFile(file),mode:stat.mode&0o777,...(architectures?{architectures}:{})};});
 const {logPath,...verifiedBuild}=built.verifiedBuild;
 const manifest={schemaVersion:1,managerId:project,version,upstreamRevision:release.upstreamRevision,platform:'darwin',arch,minimumMacOS,executableRelative,
  files:inventory,dependencies:[{file:executableRelative,links:linked}],notices:[{name:profile.repo,license:'GPL-2.0-or-later',sourceUrl:'https://github.com/kichikuou/'+profile.repo,path:license}],
  environmentRelative:{},runtimeFiles:{},signature:{identity:'-',verified:true},
  provenance:{...verifiedBuild,configureOptions:verifiedBuild.configureOptions.map(option=>option.split(work).join('maclauncher-build')),inputExecutableSha256:Native.hashFile(built.runtimePath),verifiedBuild:true}};
 B.validateManifest(manifest,{managerId:project,version:release.version,upstreamRevision:release.upstreamRevision,arch});B.verifyPayload(files,manifest);
 fs.writeFileSync(path.join(payload,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o644,flag:'wx'});
 const declaration=await managerDeclaration({project,input:payload});
 fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
 return {project,version,arch,output};
}

recipeMain(import.meta,buildDecompiler);
