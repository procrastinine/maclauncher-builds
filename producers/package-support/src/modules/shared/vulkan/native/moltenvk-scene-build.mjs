import {appRequire,appSourceRoot,recipePath} from '../../../../../../../tools/app-source.mjs';
import {addLicenses} from '../../../../../../../lib/licenses.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {source,sceneSources} from './moltenvk-scene-overlay.mjs';
import {applyTemporalSource,temporalSources} from '../../../../../../../producers/moltenvk/build.mjs';
import {writeChanged,prepareSourceTree} from './source-files.mjs';
const Bundled=appRequire('src/modules/shared/runtime/bundled-native.js');
const root=path.dirname(fileURLToPath(import.meta.url));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',maxBuffer: Infinity,...options}).trim();
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const gitEnvironment={...process.env,GIT_NO_LAZY_FETCH:'1'};
export function prepareSceneSource({repository,work}){
 const app=appSourceRoot();
 repository=fs.realpathSync(repository);work=path.resolve(work);
 if(work===repository||work.startsWith(repository+path.sep)||repository.startsWith(work+path.sep))throw Error('MoltenVK source and owned build directories must be disjoint');
 const projected=path.join(work,'source');fs.mkdirSync(work,{recursive:true});
 let adapted;
 // Offline archive is the original public source, never a modified checkout.
 const archive=path.join(work,'upstream-source.tar');
 run('git',['-C',repository,'archive','--format=tar','--output='+archive,source.revision],{env:gitEnvironment});
 try{prepareSourceTree(projected,temporary=>{run('/usr/bin/tar',['-xf',archive,'-C',temporary]);const temporal=applyTemporalSource(temporary);adapted=sceneSources(repository,file=>fs.readFileSync(path.join(temporary,file),'utf8'));for(const file of temporal)if(!adapted.has(file))adapted.set(file,fs.readFileSync(path.join(temporary,file)));for(const[file,bytes]of adapted)writeChanged(path.join(temporary,file),bytes);});}
 finally{fs.unlinkSync(archive);}
 const temporalRoot=path.resolve(root,'../../../../../../../producers/moltenvk');
 const temporalCarrier=[['producers/moltenvk/build.mjs',path.join(temporalRoot,'build.mjs')],...temporalSources.map(file=>[file,recipePath(temporalRoot,file)])].map(([file,location])=>({file,sha256:digest(fs.readFileSync(location))}));
 const inputs={profile:source,appRevision:app.revision,temporalCarrier,files:[...adapted.keys()].map(file=>({file,sha256:digest(fs.readFileSync(path.join(projected,file)))})),
  producer:['moltenvk-scene-build.mjs','moltenvk-scene-overlay.mjs','moltenvk-scene-project.cmake','source-files.mjs'].map(file=>({file,sha256:digest(fs.readFileSync(path.join(root,file)))}))};
 writeChanged(path.join(work,'scene-source.json'),JSON.stringify(inputs,null,2)+'\n');
 return projected;
}
export function checkSceneSource({projected,includes=[],compiler='/usr/bin/clang++',architecture='arm64'}){
 if(!['arm64','x86_64'].includes(architecture))throw Error('Unknown compiler target architecture');
 const base=path.join(projected,'MoltenVK/MoltenVK');
 const internal=['API','Commands','GPUObjects','Layers','OS','Utility','Vulkan'].map(name=>path.join(base,name));
 const args=['-std=c++17','-fno-objc-arc','-fblocks','-fsyntax-only','-arch',architecture,'-mmacosx-version-min='+source.minimumMacOS,
  '-DMVK_USE_CEREAL=0','-DMVK_EXCLUDE_SPIRV_TOOLS=1',
  ...[path.join(projected,'MoltenVK/include'),path.join(projected,'Common'),path.join(projected,'MoltenVKShaderConverter'),...internal,...includes].map(value=>'-I'+path.resolve(value)),
  path.join(base,'Commands/MVKCommandPool.mm')];
 run(compiler,args);return {architecture,source:source.revision};
}
export function buildSceneProvider({projected,work,dependencies,architecture='arm64',jobs=2}){
 if(!['arm64','x86_64'].includes(architecture)||!Number.isInteger(jobs)||jobs<1||jobs>2)throw Error('Invalid native compiler configuration');
 const actual={};for(const item of source.dependencies){const input=dependencies?.[item.id];if(!input||!fs.statSync(input).isDirectory())throw Error('Missing original offline source: '+item.id+' '+item.revision);actual[item.id]=fs.realpathSync(input);}
 const buildInputs=JSON.parse(fs.readFileSync(path.join(work,'scene-source.json')));
 if(JSON.stringify(buildInputs.profile)!==JSON.stringify(source)||buildInputs.files.some(row=>digest(fs.readFileSync(path.join(projected,row.file)))!==row.sha256))throw Error('Prepared scene source inputs changed');
 const wrapper=path.resolve(work,'project'),build=path.resolve(work,'build-'+architecture);fs.mkdirSync(wrapper,{recursive:true});writeChanged(path.join(wrapper,'CMakeLists.txt'),fs.readFileSync(path.join(root,'moltenvk-scene-project.cmake')));
 run('cmake',['-S',wrapper,'-B',build,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES='+architecture,
  '-DCMAKE_OSX_DEPLOYMENT_TARGET='+source.minimumMacOS,'-DMACFX_MOLTENVK_SOURCE='+path.resolve(projected),
  '-DMACFX_SPIRV_CROSS_SOURCE='+actual['SPIRV-Cross'],'-DMACFX_VULKAN_HEADERS_SOURCE='+actual['Vulkan-Headers'],'-DMACFX_CEREAL_SOURCE='+actual.cereal]);
 run('/usr/bin/nice',['-n','19','cmake','--build',build,'--target','MoltenVK','--parallel',String(jobs)]);
 const library=path.join(build,'upstream/MoltenVK/libMoltenVK.dylib');if(!fs.existsSync(library))throw Error('The original MoltenVK target did not produce its library');return {library,dependencies:actual,buildInputs};
}
export function publishSceneProvider({library,projected,output,architecture,dependencies,buildInputs}){
 if(!buildInputs||JSON.stringify(buildInputs.profile)!==JSON.stringify(source))throw Error('The raw provider requires its prepared build identity');
 output=path.resolve(output);if(fs.existsSync(output))throw Error('The immutable provider output already exists');
 fs.mkdirSync(output,{recursive:true});const name='libMoltenVK-scene.dylib',destination=path.join(output,name);fs.copyFileSync(library,destination);fs.chmodSync(destination,0o755);
 run('/usr/bin/install_name_tool',['-id','@rpath/'+name,destination]);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',destination]);
 addLicenses(output,'MoltenVK',projected);
 addLicenses(output,'VKD3D-Proton temporal carrier',path.resolve(root,'../../../../../../../producers/vkd3d-proton/source'));
 addLicenses(output,'MacLauncher',path.resolve(root,'../../../../../../..'));
 for(const item of source.dependencies){const input=dependencies[item.id];addLicenses(output,item.id,input);}

 const files=Bundled.fileInventory(output).filter(file=>file!=='provider.json').map(file=>({path:file,sha256:digest(fs.readFileSync(path.join(output,file))),size:fs.statSync(path.join(output,file)).size}));
 const provider={schema:1,provider:'moltenvk',sceneOperationAPI:1,sceneStagingAPI:1,sceneOperationResources:'prepared-tracked-boundary',originalOutputRetained:true,
  library:name,architectures:[architecture],minimumMacOS:source.minimumMacOS,files,buildInputs};
 writeChanged(path.join(output,'provider.json'),JSON.stringify(provider,null,2)+'\n');return provider;
}
/** Wrap the unchanged raw driver in the ordinary managed runtime format. */
export function publishScenePackage({providerDirectory,peerDirectory,output}){
 providerDirectory=fs.realpathSync(providerDirectory);output=path.resolve(output);
 if(fs.existsSync(output))throw Error('The immutable managed output already exists');
 const inputs=[providerDirectory,...(peerDirectory?[fs.realpathSync(peerDirectory)]:[])].map(directory=>{
 const provider=JSON.parse(fs.readFileSync(path.join(directory,'provider.json')));
 if(!provider.buildInputs||JSON.stringify(provider.buildInputs.profile)!==JSON.stringify(source))throw Error('The raw driver lacks the matching prepared build identity');
 if(provider.schema!==1||provider.provider!=='moltenvk'||provider.sceneOperationAPI!==source.sceneOperationAPI||
    provider.sceneStagingAPI!==source.sceneStagingAPI||provider.sceneOperationResources!==source.sceneOperationResources||
    provider.originalOutputRetained!==true||provider.minimumMacOS!==source.minimumMacOS||
    provider.library!=='libMoltenVK-scene.dylib'||provider.architectures?.length!==1||
    !['arm64','x86_64'].includes(provider.architectures[0]))throw Error('The raw driver differs from the managed scene profile');
 const architecture=provider.architectures[0],library=path.join(directory,provider.library);
 const expected=Bundled.fileInventory(directory).filter(file=>file!=='provider.json');
 for(const row of provider.files)Bundled.relativeFile(row.path);
 const links=read('/usr/bin/otool',['-L',library]).split('\n').slice(2).map(line=>line.trim().split(' (')[0]).filter(Boolean);
 return {directory,provider,architecture,library,links,expected};});
 const first=inputs[0],architectures=inputs.map(input=>input.architecture).sort();
 const provider={...first.provider,architectures};
 fs.mkdirSync(path.dirname(output),{recursive:true});const temporary=fs.mkdtempSync(path.join(path.dirname(output),'.moltenvk-package-'));
 try{
  for(const file of first.expected){fs.mkdirSync(path.dirname(path.join(temporary,file)),{recursive:true});fs.copyFileSync(path.join(first.directory,file),path.join(temporary,file));fs.chmodSync(path.join(temporary,file),file===provider.library?0o755:0o644);}
  if(inputs.length===2){const library=path.join(temporary,provider.library);run('/usr/bin/lipo',['-create',...inputs.map(input=>input.library),'-output',library]);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',library]);}
  provider.files=provider.files.map(row=>row.path===provider.library?{...row,sha256:digest(fs.readFileSync(path.join(temporary,row.path))),size:fs.statSync(path.join(temporary,row.path)).size}:row);
  writeChanged(path.join(temporary,'provider.json'),JSON.stringify(provider,null,2)+'\n');
  const files=Bundled.fileInventory(temporary).map(file=>{const stored=Bundled.readRegular(path.join(temporary,file),Bundled.LIMITS.fileBytes);return {path:file,size:stored.size,mode:stored.mode,sha256:stored.sha256,...(file===provider.library?{architectures}:{})};});
  const manifest={schemaVersion:1,managerId:source.projectId,version:source.version,upstreamRevision:source.revision,
   platform:'darwin',arch:inputs.length===2?'universal':architectures[0]==='x86_64'?'x64':'arm64',minimumMacOS:source.minimumMacOS,
   executableRelative:provider.library,files,dependencies:[{file:provider.library,links:first.links}],provider,
   provenance:{sourceRevision:source.revision,sourceUrl:source.repository,upstreamVersion:source.upstreamVersion,
    adaptationVersion:source.adaptationVersion,buildInputs:provider.buildInputs,packageProducer:{file:'moltenvk-scene-build.mjs',sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url)))}}};
  Bundled.validateManifest(manifest);Bundled.verifyPayload(temporary,manifest);
  writeChanged(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  fs.renameSync(temporary,output);return manifest;
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const values={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(!key.startsWith('--'))throw Error('Unknown build argument');values[key]=process.argv[++i];}
 if(!values['--source']||!values['--work'])throw Error('Usage: node moltenvk-scene-build.mjs --source <exact Git source> --work <owned build> [--check <include paths joined by path delimiter>] [--spirv-cross <Git source> --vulkan-headers <Git source> --cereal <Git source> --output <new immutable provider> --package-output <new managed package> --package-peer <other architecture raw provider>]');
 if(values['--package-output']&&!values['--output'])throw Error('A managed package requires the raw provider output');
 if(values['--package-peer']&&!values['--package-output'])throw Error('A second architecture requires the managed package output');
 const projected=prepareSceneSource({repository:values['--source'],work:values['--work']});
 if(values['--check']!==undefined)checkSceneSource({projected,includes:values['--check'].split(path.delimiter).filter(Boolean),architecture:values['--architecture']||'arm64'});
 if(values['--output']){const architecture=values['--architecture']||'arm64';const built=buildSceneProvider({projected,work:values['--work'],dependencies:{'SPIRV-Cross':values['--spirv-cross'],'Vulkan-Headers':values['--vulkan-headers'],cereal:values['--cereal']},architecture});publishSceneProvider({...built,projected,output:values['--output'],architecture});if(values['--package-output'])publishScenePackage({providerDirectory:values['--output'],peerDirectory:values['--package-peer'],output:values['--package-output']});}
}
