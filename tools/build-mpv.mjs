import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {pythonBuildTools,recipeMain} from './build-source.mjs';
import {retryNetwork} from './download.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Native=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const run=(command,args,options={})=>String(execFileSync(command,args,{encoding:'utf8',maxBuffer:Infinity,...options})||'').trim();
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** pkgconf follows private cflags requirements even for dynamic linking. The
 * selected Apple SDK supplies these libraries without Homebrew formulae. */
export function sdkCompressionPkgConfig({sdk,directory}){
 const version=(file,pattern)=>{const match=pattern.exec(fs.readFileSync(path.join(sdk,'usr/include',file),'utf8'));if(!match)throw Error('The selected SDK has no compression library version: '+file);return match[1];};
 const packages=[['zlib',version('zlib.h',/#define ZLIB_VERSION "([0-9.]+)"/),'z'],['bzip2',version('bzlib.h',/bzip2\/libbzip2 version ([0-9.]+)/),'bz2']];
 fs.mkdirSync(directory,{recursive:true});
 for(const [name,release,library] of packages){
  fs.accessSync(path.join(sdk,'usr/lib','lib'+library+'.tbd'));
  fs.writeFileSync(path.join(directory,name+'.pc'),'prefix='+path.join(sdk,'usr')+'\nName: '+name+'\nDescription: Apple SDK '+name+'\nVersion: '+release+'\nLibs: -l'+library+'\nCflags:\n');
 }
 return directory;
}
export async function buildMPV({project:id,arch,output,work}){
 const record=buildRecord(resolveProject(id,root));
 fs.mkdirSync(work,{recursive:true});
 const tools=pythonBuildTools(work,path.join(root,'tools/sdk27-build-requirements.txt'));
 const producer=path.join(root,'producers/mpv-render/v7'),source=path.join(root,'producers/maclauncher/src/external/mpv-player');
 const Builder=require(path.join(producer,'maclauncher/scripts/build-mpv-library.cjs'));
 (await import(pathToFileURL(path.join(producer,'package.mjs')))).checkSources();
 retryNetwork(()=>run('git',['-C',source,'fetch','--depth','2','origin',Builder.REVISION,...Builder.BACKPORTS],{stdio:'inherit'}));
 const sdk=process.env.SDKROOT||run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path']);
 const sdkPackages=sdkCompressionPkgConfig({sdk,directory:path.join(work,'sdk-pkgconfig')});
 const pkgConfigPath=[sdkPackages,process.env.PKG_CONFIG_PATH,run('pkgconf',['--variable','pc_path','pkg-config'])].filter(Boolean).join(path.delimiter);
 const built=Builder.build({sourceCheckout:source,workDirectory:path.join(work,'library'),toolsDirectory:tools.bin,pkgConfigPath,minimumMacOS:'14.0',jobs:4});
 const recipe=JSON.parse(fs.readFileSync(path.join(producer,'source.json'))),owned=path.join(producer,'maclauncher'),staged=path.join(work,'staged'),app=path.join(staged,'mpv.app'),executable=path.join(app,'Contents/MacOS/mpv');
 fs.mkdirSync(path.dirname(executable),{recursive:true});fs.mkdirSync(path.join(app,'Contents/Frameworks/video'),{recursive:true});
 fs.copyFileSync(built.library,path.join(app,'Contents/Frameworks/video/libmpv.2.dylib'));
 const flags=['clang++','-std=c++17','-O2','-fobjc-arc','-Wno-deprecated-declarations','-arch','arm64','-mmacosx-version-min=14.0','-ffile-prefix-map='+owned+'=.',
  '-I'+path.join(owned,'src/external/mpv-player/include'),'-I'+path.join(owned,'src/modules/shared/reshade/native')];
 run('/usr/bin/xcrun',[...flags,...['mpv-render.mm','gpu-surface.mm'].map(name=>path.join(owned,'src/modules/video/native',name)),...['AppKit','Metal','QuartzCore','OpenGL','CoreVideo','IOSurface'].flatMap(name=>['-framework',name]),'-Wl,-rpath,@executable_path/../Frameworks/video','-o',executable],{stdio:'inherit'});
 const info=JSON.parse(run(executable,['--maclauncher-info']));
 fs.writeFileSync(path.join(app,'Contents/Info.plist'),'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.maclauncher.video</string><key>CFBundleExecutable</key><string>mpv</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.41.0</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>');
 const librarySource={url:recipe.source.repository,commit:Builder.REVISION,version:'0.41.0',backports:Builder.BACKPORTS,inputSha256:hash(built.library),verifiedBuild:true,build:built.metadata};
 const video={schema:1,id:'mpv-render',version:record.version,minimumMacOS:'14.0',architecture:'arm64',libraryVersion:info.libraryVersion,librarySource,headerSource:{repository:recipe.source.repository,commit:Builder.REVISION},scaleFilters:info.scaleFilters,images:[],
  ...Object.fromEntries(['decodedFrameAPI','decodedColorAPI','preparationNotificationAPI','osdLayerAPI','playerScriptsAPI','playerInputAPI','intermediateColor','outputColor'].map(key=>[key,recipe[key]??1])),
  ownedInputs:recipe.ownedInputs};
 const descriptor=path.join(staged,'video-runtime.json');fs.writeFileSync(descriptor,JSON.stringify(video,null,2)+'\n');
 const result=await sealRuntime({project:id,arch,output,sourceRoot:source,upstreamRevision:Builder.REVISION,executable,appRoot:app,payloads:[{source:descriptor,relative:'video-runtime.json'}],runtimeFiles:{decodedFrameManifest:'video-runtime.json'},provenance:{libraryBuild:built.metadata},jsonMetadata:{'video-runtime.json':(value,{files})=>{
   const inventory=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?inventory(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
   const images=inventory(files).filter(file=>Native.macho(file)).map(file=>({path:path.relative(files,file).split(path.sep).join('/'),sha256:hash(file)}));
   const minimumMacOS=images.map(image=>Native.loadCommands(path.join(files,image.path),'arm64').minimumMacOS).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
   return {...value,minimumMacOS,images};
  }}});
 return result;
}
recipeMain(import.meta,buildMPV);
