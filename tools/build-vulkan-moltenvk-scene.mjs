import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {checkoutSource,recipeMain} from './build-source.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {root,base,read,assemble as sceneAssemble} from './scene-runtime.mjs';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const native=path.join(base,'src/modules/shared/vulkan/native');
/** Compile the MoltenVK scene provider for each CPU of the package. */
export async function compile({project:id,arch,work}){
 const record=buildRecord(resolveProject(id,root,{resolvePins:false}));
 fs.mkdirSync(work,{recursive:true});
 const source=read(path.join(native,'moltenvk-scene-source.json'));
 const repository=checkoutSource({...source,destination:path.join(work,'moltenvk')}),dependencies={};
 for(const dependency of source.dependencies)dependencies[dependency.id]=checkoutSource({...dependency,revision:dependency.revision||fs.readFileSync(path.join(repository,'ExternalRevisions',dependency.id+'_repo_revision'),'utf8').trim(),destination:path.join(work,dependency.id)});
 const producer=await import(pathToFileURL(path.join(native,'moltenvk-scene-build.mjs'))),prepared=path.join(work,'provider-build');
 const projected=producer.prepareSceneSource({repository,work:prepared}),cpus=arch==='universal'?['arm64','x86_64']:[arch==='x64'?'x86_64':arch],built=[];
 for(const architecture of cpus)built.push({architecture,...producer.buildSceneProvider({projected,work:prepared,dependencies,architecture,jobs:2})});
 return {record,projected,built};
}
/** Sign each compiled provider, join them into one package and declare it. */
export async function assemble({project:id,arch,output,work,compiled:{record,projected,built}}){
 const producer=await import(pathToFileURL(path.join(native,'moltenvk-scene-build.mjs'))),providers=[];
 for(const {architecture,...provider} of built){const directory=path.join(work,'raw-'+architecture);producer.publishSceneProvider({...provider,projected,output:directory,architecture});providers.push(directory);}
 const directory=path.join(work,'package'),manifest=producer.publishScenePackage({providerDirectory:providers[0],peerDirectory:providers[1],output:directory});
 const manifestFile=path.join(directory,'manifest.json'),files=[...manifest.files,{path:'manifest.json',size:fs.statSync(manifestFile).size,mode:0o644,sha256:hash(manifestFile)}];
 const declaration={id,version:record.version,arch,launcherArchitectures:arch==='arm64'?['arm64']:['arm64','x64'],minimumMacOS:manifest.minimumMacOS,
  sourceRelative:null,sourceSha256:hash(path.join(native,'moltenvk-scene-source.json')),directoryRelative:[id,record.version,arch].join('/'),manifestRelative:'manifest.json',manifestSha256:hash(manifestFile),files};
 return sceneAssemble({output,compiled:{directory,declaration}});
}
recipeMain(import.meta,{compile,assemble});
