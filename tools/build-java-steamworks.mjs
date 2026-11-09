import './producer-environment.mjs';
import {addLicenses,addLicense} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
import {downloadBytes} from './download.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/package-support/src/modules/java/runtime/steamworks');
const {build}=require(path.join(base,'build-agent.cjs')),catalog=require(path.join(base,'publisher-releases.json'));
/** Select the original ABI source independently of the Builds package revision. */
export function javaSteamworksProfile(version){
 const upstream=/^(.+)-MCLv[1-9]\d*$/.exec(version||'')?.[1],matches=catalog.filter(row=>row.version===upstream);
 if(matches.length!==1)throw Error('The Steamworks4j catalog has no ABI release for '+version+'.');
 return matches[0];
}
export async function buildJavaSteamworks({project:id,arch,version,output,work}){
 const project=resolveProject(id,root,{resolvePins:false}),original=javaSteamworksProfile(version);
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});fs.mkdirSync(work,{recursive:true});
 try {
  const publisher=path.join(work,'publisher.jar');fs.writeFileSync(publisher,await downloadBytes(original.publisherUrl));
  if(sha(publisher)!==original.publisherJarSha256)throw Error('Publisher Steamworks4j archive checksum differs.');
  const library=path.join(payload,'libsteamworks4j.dylib');fs.writeFileSync(library,execFileSync('/usr/bin/unzip',['-p',publisher,'libsteamworks4j.dylib'],{maxBuffer:Infinity}),{mode:0o755});
  const jdkBin=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin'):path.join(execFileSync('/usr/libexec/java_home',['-v','17+'],{maxBuffer:Infinity,encoding:'utf8'}).trim(),'bin');
  const agent=build(jdkBin,path.join(payload,'steam-agent.jar'));
  addLicenses(payload,'MacLauncher',root);
  addLicense(payload,'steamworks4j '+original.version,path.join(base,'steamworks4j-'+original.version+'-MIT.txt'));
  return helperPackage({id:project.id,version,arch,output,minimumMacOS:arch==='x64'?'10.9':'11.0',sourceSha256:agent.sourceSha256,rosettaFiles:arch==='x64'?['libsteamworks4j.dylib']:[],
   record:{wrapperVersion:original.version,sourceRevision:original.sourceRevision,sourceUrl:original.sourceUrl,sourceKind:'reviewed-binary',verifiedBuild:false,publisherUrl:original.publisherUrl,publisherJarSha256:original.publisherJarSha256,
    librarySha256:sha(library),agentSha256:agent.sha256,agentSourceSha256:agent.sourceSha256,agentCompilerRuntime:execFileSync(path.join(jdkBin,'javac'),['-version'],{maxBuffer:Infinity,encoding:'utf8'}).trim(),agentClassMajor:52,abiProfile:original.abiProfile,interfaces:original.interfaces,symbols:original.symbols}});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,buildJavaSteamworks);
