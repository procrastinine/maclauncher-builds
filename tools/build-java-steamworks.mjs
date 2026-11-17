import './producer-environment.mjs';
import {addLicenses,addLicense} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {archiveInput,sourceRevision} from '../lib/pins.mjs';
import {compileNative} from './java-steamworks-native.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/package-support/src/modules/java/runtime/steamworks');
const {build}=require(path.join(base,'build-agent.cjs')),catalog=require(path.join(base,'publisher-releases.json'));
/** Select the original ABI source independently of the Builds package revision. */
export function javaSteamworksProfile(version){
 const upstream=/^(.+)-MCLv[1-9]\d*$/.exec(version||'')?.[1],matches=catalog.filter(row=>row.version===upstream);
 if(matches.length!==1)throw Error('The Steamworks4j catalog has no ABI release for '+version+'.');
 const original=matches[0];
 return original.source?{...original,sourceRevision:sourceRevision(original.source)}:original;
}
/** Read the reviewed JNI library from the publisher archive and compile the agent into the payload. */
export async function compile({project:id,version,arch,output,work}){
 const project=resolveProject(id,root,{resolvePins:false}),original=javaSteamworksProfile(version);
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});fs.mkdirSync(work,{recursive:true});
 try {
  const publisher=path.join(work,'publisher.jar');fs.copyFileSync(await buildInput(archiveInput(original)),publisher);
  const jdkBin=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin'):path.join(execFileSync('/usr/libexec/java_home',['-v','17+'],{maxBuffer:Infinity,encoding:'utf8'}).trim(),'bin');
  const rebuilt=original.version==='1.9.0'&&Number(/-MCLv(\d+)$/.exec(version)[1])>=8?await compileNative({original,arch,work,jdkBin}):null;
  const library=path.join(payload,'libsteamworks4j.dylib');
  if(rebuilt){fs.copyFileSync(rebuilt.library,library);fs.copyFileSync(rebuilt.dependency,path.join(payload,'libsteam_api.dylib'));}
  else fs.writeFileSync(library,execFileSync('/usr/bin/unzip',['-p',publisher,'libsteamworks4j.dylib'],{maxBuffer:Infinity}),{mode:0o755});
  const agent=build(jdkBin,path.join(payload,'steam-agent.jar'));
  const agentCompilerRuntime=execFileSync(path.join(jdkBin,'javac'),['-version'],{maxBuffer:Infinity,encoding:'utf8'}).trim();
  return {original,project,agent,agentCompilerRuntime,library,rebuilt};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
/** Add the notices and describe the payload. */
export async function assemble({arch,version,output,work,compiled:{original,project,agent,agentCompilerRuntime,library,rebuilt}}){
 const payload=path.join(output,'payload');
 try {
  addLicenses(payload,'MacLauncher',root);
  addLicense(payload,'steamworks4j '+original.version,path.join(base,'steamworks4j-'+original.version+'-MIT.txt'));
  if(rebuilt)addLicenses(payload,'Steamworks SDK',rebuilt.sdk);
  return helperPackage({id:project.id,version,arch,output,minimumMacOS:rebuilt?'11.0':arch==='x64'?'10.9':'11.0',sourceSha256:agent.sourceSha256,rosettaFiles:arch==='x64'?['libsteamworks4j.dylib']:[],
   record:{wrapperVersion:original.version,sourceRevision:original.sourceRevision,sourceUrl:original.sourceUrl,sourceKind:rebuilt?'source':'reviewed-binary',verifiedBuild:Boolean(rebuilt),...(rebuilt?{sourceBuild:rebuilt.sourceBuild}:{}),publisherUrl:original.archiveUrl,publisherJarSha256:original.archiveSha256,
    librarySha256:sha(library),agentSha256:agent.sha256,agentCompilerRuntime,agentClassMajor:52,abiProfile:original.abiProfile,interfaces:original.interfaces,symbols:original.symbols}});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,{compile,assemble});
