import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/maclauncher/src/modules/java/runtime/steamworks');
const {build}=require(path.join(base,'build-agent.cjs')),Zip=require('../producers/maclauncher/src/modules/shared/runtime/zip.js'),catalog=require(path.join(base,'versions.json'));
const o={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]?.slice(2);if(!['project','arch','version','output','work'].includes(key)||!process.argv[i+1]||Object.hasOwn(o,key))throw Error('Use --project, --arch, --version, --output and --work.');o[key]=process.argv[i+1];}
const project=resolveProject(o.project,root,{resolvePins:false}),buildProfile=buildRecord(project,o.version),original=catalog.find(row=>o.version===row.version+'-MCLv2');
if(o.project!=='java-steamworks'||!original||!buildProfile.architectures.includes(o.arch)||!path.isAbsolute(o.output||'')||fs.existsSync(o.output)||!path.isAbsolute(o.work||'')||fs.existsSync(o.work))throw Error('Select a declared Java Steamworks ABI version and new absolute output and work directories.');
const payload=path.join(o.output,'payload');fs.mkdirSync(payload,{recursive:true});fs.mkdirSync(o.work,{recursive:true});
try {
 const publisher=path.join(o.work,'publisher.jar'),response=await fetch(original.publisherUrl);if(!response.ok)throw Error('Publisher archive returned HTTP '+response.status);fs.writeFileSync(publisher,Buffer.from(await response.arrayBuffer()));
 if(sha(publisher)!==original.publisherJarSha256)throw Error('Publisher Steamworks4j archive checksum differs.');
 const bytes=Zip.readZipEntryBuffer(publisher,'libsteamworks4j.dylib'),library=path.join(payload,'libsteamworks4j.dylib');fs.writeFileSync(library,bytes,{mode:0o755});
 if(sha(library)!==original.jniSha256||bytes.length!==original.jniSize)throw Error('Publisher JNI library differs.');
 execFileSync('/usr/bin/codesign',['--verify','--strict',library],{stdio:'pipe'});
 const jdkBin=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin'):path.join(execFileSync('/usr/libexec/java_home',['-v','17+'],{encoding:'utf8'}).trim(),'bin');
 const agent=build(jdkBin,path.join(payload,'steam-agent.jar'));
 fs.copyFileSync(path.join(base,'steamworks4j-'+original.version+'-MIT.txt'),path.join(payload,'steamworks4j-MIT.txt'));
 fs.copyFileSync(path.join(root,'producers/maclauncher/LICENSE'),path.join(payload,'MacLauncher-MIT.txt'));
 console.log(JSON.stringify(helperPackage({id:project.id,version:o.version,arch:o.arch,output:o.output,minimumMacOS:o.arch==='x64'?'10.9':'11.0',sourceSha256:agent.sourceSha256,rosettaFiles:o.arch==='x64'?['libsteamworks4j.dylib']:[],
  record:{wrapperVersion:original.version,sourceRevision:original.sourceRevision,sourceUrl:original.sourceUrl,sourceKind:'reviewed-binary',verifiedBuild:false,publisherUrl:original.publisherUrl,publisherJarSha256:original.publisherJarSha256,
   librarySha256:original.jniSha256,agentSha256:agent.sha256,agentSourceSha256:agent.sourceSha256,agentCompilerRuntime:execFileSync(path.join(jdkBin,'javac'),['-version'],{encoding:'utf8'}).trim(),agentClassMajor:52,abiProfile:original.abiProfile,interfaces:original.interfaces,symbols:original.symbols},
  notices:[{name:'steamworks4j '+original.version,license:'MIT',path:'steamworks4j-MIT.txt',sourceUrl:original.sourceUrl},{name:'MacLauncher Java loader',license:'MIT',path:'MacLauncher-MIT.txt'}]})));
}catch(error){fs.rmSync(o.output,{recursive:true,force:true});throw error;}finally{fs.rmSync(o.work,{recursive:true,force:true});}
