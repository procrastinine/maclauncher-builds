import './producer-environment.mjs';
import {appPath,appRequire} from './app-source.mjs';
import {addLicenses,addLicense} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
import {downloadBytes} from './download.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),base=appPath('src/modules/java/runtime/steamworks');
const {build}=require(path.join(base,'build-agent.cjs')),Zip=appRequire('src/modules/shared/runtime/zip.js'),catalog=require(path.join(base,'versions.json'));
/** Select the original ABI source independently of the Builds package revision. */
export function javaSteamworksProfile(version){
 const upstream=/^(.+)-MCLv[1-9]\d*$/.exec(version||'')?.[1],matches=catalog.filter(row=>row.version===upstream);
 if(matches.length!==1)throw Error('The Steamworks4j catalog has no ABI release for '+version+'.');
 return matches[0];
}
/** Fetch the reviewed JNI library and compile the agent into the payload. */
export async function compile({project:id,version,output,work}){
 const project=resolveProject(id,root,{resolvePins:false}),original=javaSteamworksProfile(version);
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});fs.mkdirSync(work,{recursive:true});
 try {
  const publisher=path.join(work,'publisher.jar');fs.writeFileSync(publisher,await downloadBytes(original.publisherUrl));
  if(sha(publisher)!==original.publisherJarSha256)throw Error('Publisher Steamworks4j archive checksum differs.');
  const bytes=Zip.readZipEntryBuffer(publisher,'libsteamworks4j.dylib'),library=path.join(payload,'libsteamworks4j.dylib');fs.writeFileSync(library,bytes,{mode:0o755});
  if(sha(library)!==original.jniSha256||bytes.length!==original.jniSize)throw Error('Publisher JNI library differs.');
  const jdkBin=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin'):path.join(execFileSync('/usr/libexec/java_home',['-v','17+'],{maxBuffer:Infinity,encoding:'utf8'}).trim(),'bin');
  const agent=build(jdkBin,path.join(payload,'steam-agent.jar'));
  return {original,project,agent,jdkBin};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});fs.rmSync(work,{recursive:true,force:true});throw error;}
}
/** Add the notices and describe the payload. */
export async function assemble({arch,version,output,work,compiled:{original,project,agent,jdkBin}}){
 const payload=path.join(output,'payload');
 try {
  addLicenses(payload,'MacLauncher',root);
  addLicense(payload,'steamworks4j '+original.version,path.join(base,'steamworks4j-'+original.version+'-MIT.txt'));
  return helperPackage({id:project.id,version,arch,output,minimumMacOS:arch==='x64'?'10.9':'11.0',sourceSha256:agent.sourceSha256,rosettaFiles:arch==='x64'?['libsteamworks4j.dylib']:[],
   record:{wrapperVersion:original.version,sourceRevision:original.sourceRevision,sourceUrl:original.sourceUrl,sourceKind:'reviewed-binary',verifiedBuild:false,publisherUrl:original.publisherUrl,publisherJarSha256:original.publisherJarSha256,
    librarySha256:original.jniSha256,agentSha256:agent.sha256,agentSourceSha256:agent.sourceSha256,agentCompilerRuntime:execFileSync(path.join(jdkBin,'javac'),['-version'],{maxBuffer:Infinity,encoding:'utf8'}).trim(),agentClassMajor:52,abiProfile:original.abiProfile,interfaces:original.interfaces,symbols:original.symbols}});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,{compile,assemble});
