import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {checkoutSource,recipeMain} from './build-source.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {root,base,read,assemble as sceneAssemble} from './scene-runtime.mjs';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const native=path.join(base,'src/modules/shared/vulkan/native'),producer=()=>import(pathToFileURL(path.join(native,'moltenvk-scene-build.mjs')));
const cpus=arch=>arch==='universal'?['arm64','x86_64']:[arch==='x64'?'x86_64':arch];
/** The named scene library of one CPU: the compile phase's only output. */
const compiledLibrary=(work,architecture)=>path.join(work,'compiled',architecture,'libMoltenVK-scene.dylib');
/** Fetch the declared MoltenVK sources and project the scene source; nothing is compiled. */
export async function prepare({work}){
 fs.mkdirSync(work,{recursive:true});
 const source=read(path.join(native,'moltenvk-scene-source.json'));
 const repository=checkoutSource({...source,destination:path.join(work,'moltenvk')}),dependencies={};
 for(const dependency of source.dependencies)dependencies[dependency.id]=checkoutSource({...dependency,revision:dependency.revision||fs.readFileSync(path.join(repository,'ExternalRevisions',dependency.id+'_repo_revision'),'utf8').trim(),destination:path.join(work,dependency.id)});
 const prepared=path.join(work,'provider-build');
 return {dependencies,prepared,projected:(await producer()).prepareSceneSource({repository,work:prepared})};
}
/** Compile the MoltenVK scene provider for each CPU of the package and name its library. */
export async function compile({arch,work,prepared:{dependencies,prepared,projected}}){
 const build=await producer();
 for(const architecture of cpus(arch)){
  const {library}=build.buildSceneProvider({projected,work:prepared,dependencies,architecture,jobs:2});
  build.nameSceneProvider({library,output:path.dirname(compiledLibrary(work,architecture))});
 }
}
/** Describe each compiled provider, join them into one package and declare it. */
export async function assemble({project:id,arch,output,work,prepared:{dependencies,prepared,projected}}){
 const build=await producer(),record=buildRecord(resolveProject(id,root,{resolvePins:false})),buildInputs=read(path.join(prepared,'scene-source.json')),providers=[];
 for(const architecture of cpus(arch)){const directory=path.join(work,'raw-'+architecture);build.publishSceneProvider({library:compiledLibrary(work,architecture),projected,output:directory,architecture,dependencies,buildInputs});providers.push(directory);}
 const directory=path.join(work,'package'),manifest=build.publishScenePackage({providerDirectory:providers[0],peerDirectory:providers[1],output:directory});
 const manifestFile=path.join(directory,'manifest.json'),files=[...manifest.files,{path:'manifest.json',size:fs.statSync(manifestFile).size,mode:0o644,sha256:hash(manifestFile)}];
 const declaration={id,version:record.version,arch,launcherArchitectures:arch==='arm64'?['arm64']:['arm64','x64'],minimumMacOS:manifest.minimumMacOS,
  sourceRelative:null,sourceSha256:hash(path.join(native,'moltenvk-scene-source.json')),directoryRelative:[id,record.version,arch].join('/'),manifestRelative:'manifest.json',manifestSha256:hash(manifestFile),files};
 return sceneAssemble({output,compiled:{directory,declaration}});
}
recipeMain(import.meta,{prepare,compile,assemble});
