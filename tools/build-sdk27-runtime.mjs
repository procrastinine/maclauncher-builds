import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {buildKosmic} from '../producers/maclauncher/src/modules/shared/vulkan/native/kosmickrisp-build.mjs';
import {buildKosmicLoader} from '../producers/maclauncher/src/modules/shared/vulkan/native/kosmickrisp-targets.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Native=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const run=(command,args,options={})=>String(execFileSync(command,args,{encoding:'utf8',maxBuffer:64<<20,...options})||'').trim();
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const prefix=name=>run('brew',['--prefix',name]);
export async function buildSDKRuntime({project:id,arch,output,work}){
 const project=resolveProject(id,root),record=buildRecord(project);
 if(!['mpv','vulkan-kosmickrisp-gles32'].includes(id)||arch!=='arm64'||process.arch!=='arm64'||process.platform!=='darwin'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select an ARM media or KosmicKrisp build and new absolute work/output paths.');
 fs.mkdirSync(work,{recursive:true});
 const environment=path.join(work,'tools');
 run('uv',['venv','--python','3.13',environment],{stdio:'inherit'});
 run('uv',['pip','install','--python',path.join(environment,'bin/python'),'--no-deps','--requirement',path.join(root,'tools/sdk27-build-requirements.txt')],{stdio:'inherit'});
 const meson=path.join(environment,'bin/meson'),ninja=path.join(environment,'bin/ninja');
 if(id==='mpv'){
  const producer=path.join(root,'producers/mpv-render/v7'),source=path.join(root,'producers/maclauncher/src/external/mpv-player');
  const Builder=require(path.join(producer,'maclauncher/scripts/build-mpv-library.cjs'));
  (await import(pathToFileURL(path.join(producer,'package.mjs')))).checkSources();
  run('git',['-C',source,'fetch','--depth','2','origin',Builder.REVISION,...Builder.BACKPORTS],{stdio:'inherit'});
  const pkgConfigPath=['ffmpeg','libass','libplacebo','luajit','mujs'].map(name=>path.join(prefix(name),'lib/pkgconfig')).join(path.delimiter);
  const built=Builder.build({sourceCheckout:source,workDirectory:path.join(work,'library'),toolsDirectory:path.join(environment,'bin'),pkgConfigPath,minimumMacOS:'14.0',jobs:4});
  const recipe=JSON.parse(fs.readFileSync(path.join(producer,'source.json'))),owned=path.join(producer,'maclauncher'),staged=path.join(work,'staged'),app=path.join(staged,'mpv.app'),executable=path.join(app,'Contents/MacOS/mpv');
  fs.mkdirSync(path.dirname(executable),{recursive:true});fs.mkdirSync(path.join(app,'Contents/Frameworks/video'),{recursive:true});
  fs.copyFileSync(built.library,path.join(app,'Contents/Frameworks/video/libmpv.2.dylib'));
  const flags=['clang++','-std=c++17','-O2','-fobjc-arc','-Wno-deprecated-declarations','-arch','arm64','-mmacosx-version-min=14.0','-ffile-prefix-map='+owned+'=.',
   '-I'+path.join(owned,'src/external/mpv-player/include'),'-I'+path.join(owned,'src/modules/shared/reshade/native')];
  run('/usr/bin/xcrun',[...flags,...['mpv-render.mm','gpu-surface.mm'].map(name=>path.join(owned,'src/modules/video/native',name)),...['AppKit','Metal','QuartzCore','OpenGL','CoreVideo','IOSurface'].flatMap(name=>['-framework',name]),'-Wl,-rpath,@executable_path/../Frameworks/video','-o',executable],{stdio:'inherit'});
  const info=JSON.parse(run(executable,['--maclauncher-info']));
  for(const key of ['decodedFrameAPI','decodedColorAPI','preparationNotificationAPI','osdLayerAPI','playerScriptsAPI','playerInputAPI'])if(info[key]!==1)throw Error('The fresh media library lacks '+key);
  if(info.schema!==1||!String(info.libraryVersion).includes('0.41.0'))throw Error('The fresh media library version differs.');
  fs.writeFileSync(path.join(app,'Contents/Info.plist'),'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.maclauncher.video</string><key>CFBundleExecutable</key><string>mpv</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.41.0</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>');
  const librarySource={url:recipe.source.repository,commit:Builder.REVISION,version:'0.41.0',backports:Builder.BACKPORTS,inputSha256:hash(built.library),verifiedBuild:true,build:built.metadata};
  const video={schema:1,id:'mpv-render',version:record.version,minimumMacOS:'14.0',architecture:'arm64',libraryVersion:info.libraryVersion,librarySource,headerSource:{repository:recipe.source.repository,commit:Builder.REVISION},scaleFilters:info.scaleFilters,images:[],notices:[],
   ...Object.fromEntries(['decodedFrameAPI','decodedColorAPI','preparationNotificationAPI','osdLayerAPI','playerScriptsAPI','playerInputAPI','intermediateColor','outputColor'].map(key=>[key,recipe[key]??1])),
   ownedInputs:recipe.ownedInputs};
  const descriptor=path.join(staged,'video-runtime.json');fs.writeFileSync(descriptor,JSON.stringify(video,null,2)+'\n');
  const notices=['Copyright','LICENSE.GPL','LICENSE.LGPL'].map(name=>({file:path.join(source,name),name:'mpv '+name,license:'GPL-2.0-or-later AND LGPL-2.1-or-later',sourceUrl:recipe.source.repository}));
  const result=await sealRuntime({project:id,arch,output,sourceRoot:source,upstreamRevision:Builder.REVISION,executable,appRoot:app,maximumMacOS:'27.0',notices,
   payloads:[{source:descriptor,relative:'video-runtime.json'}],runtimeFiles:{decodedFrameManifest:'video-runtime.json'},provenance:{libraryBuild:built.metadata},
   jsonMetadata:{'video-runtime.json':(value,{files})=>{
    const inventory=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?inventory(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
    const images=inventory(files).filter(file=>Native.macho(file)).map(file=>({path:path.relative(files,file).split(path.sep).join('/'),sha256:hash(file)}));
    const minimumMacOS=images.map(image=>Native.loadCommands(path.join(files,image.path),'arm64').minimumMacOS).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
    return {...value,minimumMacOS,images};
   }}});
  const sealedInfo=JSON.parse(run(path.join(output,'payload/files/mpv.app/Contents/MacOS/mpv'),['--maclauncher-info']));
  if(sealedInfo.libraryVersion!==info.libraryVersion)throw Error('Sealed media library differs from its build.');return result;
 }
 const native=path.join(root,'producers/maclauncher/src/modules/shared/vulkan/native'),pin=JSON.parse(fs.readFileSync(path.join(native,'kosmickrisp-source.json'))),inputs=JSON.parse(fs.readFileSync(path.join(native,'kosmickrisp-targets.json'))),source=path.join(root,inputs.sourcePath);
 const built=buildKosmic({source,work:path.join(work,'mesa'),meson,ninja,llvm:prefix('llvm'),architecture:arch,jobs:2});
 const loader=buildKosmicLoader({source:path.join(root,inputs.vulkanLoader.path),headersSource:path.join(root,inputs.vulkanHeaders.path),work:path.join(work,'loader'),architecture:arch,jobs:2});
 const notices=[{file:path.join(source,'docs/license.rst'),name:'Mesa',license:'MIT and upstream notices',sourceUrl:pin.repository},{file:loader.loaderNotice,name:'Vulkan-Loader',license:'Apache-2.0',sourceUrl:inputs.vulkanLoader.repository}];
 for(const name of fs.readdirSync(path.join(source,'licenses')))if(fs.statSync(path.join(source,'licenses',name)).isFile())notices.push({file:path.join(source,'licenses',name),name:'Mesa '+name,license:name,sourceUrl:pin.repository});
 return sealRuntime({project:id,arch,output,sourceRoot:source,upstreamRevision:pin.revision,executable:built.library,executableRelative:pin.library,maximumMacOS:'27.0',notices,
  payloads:[{source:loader.loader,relative:'libvulkan.1.dylib'}],runtimeFiles:{loader:'libvulkan.1.dylib'},provenance:{targetInputs:inputs,capabilities:{openglES:'3.2',geometry:'Mesa Poly',transformFeedback:'Mesa Poly'}}});
}
export async function main(args){const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','arch','output','work'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project, --arch, --output and --work.');options[key]=args[i+1];}return buildSDKRuntime(options);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
