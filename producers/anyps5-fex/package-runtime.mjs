// SPDX-License-Identifier: GPL-2.0-only
// Packages the AnyPS5 on FEX start host for arm64 macOS as a MacLauncher runtime.
//
//   node producers/anyps5-fex/package-runtime.mjs --start-build <directory> --output <directory> --version <version>
//     [--anyps5-source <directory>]
//
// --start-build is the directory build-proof.mjs links the start host into (its Bin folder, holding anyps5-fex-start and
// the libSDL2 it loads from @executable_path). The payload holds one application bundle, AnyPS5.app, with both files in
// Contents/MacOS, so the host runs with the bundle's name and the games category. Beside it are the licences of AnyPS5,
// its dependencies, FEX and the FEX submodules the host links, source.json with the exact source revisions, overlay and
// producer input digests, and runtime.json, the manifest the launcher reads. --anyps5-source names another checkout of
// AnyPS5 at the declared revision with its dependencies' submodules, for the licence texts; it defaults to the gitlink.
import {gitlink,sourceCheckout,sourceProvenance,sourceRevision} from '../../lib/pins.mjs';
import {addLicense,addLicenses} from '../../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack} from '../../tools/runtime-package.mjs';
import {assetName} from '../../lib/project-identity.mjs';

const require=createRequire(import.meta.url),Native=require('../../lib/package-format.cjs');
const root=path.resolve(import.meta.dirname,'../..');
const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json')));
const anyps5Recipe=JSON.parse(fs.readFileSync(path.join(root,'producers/anyps5/source.json')));
const {inputs:anyps5Dependencies,sourceDirectory}=await import('../anyps5/source-projection.mjs');
const HOST='AnyPS5.app/Contents/MacOS/anyps5-fex-start',SDL='AnyPS5.app/Contents/MacOS/libSDL2-2.0.0.dylib';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
function copy(from,to,mode=0o644){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);fs.chmodSync(to,mode);}
function filesIn(directory,prefix=''){
 return fs.readdirSync(path.join(directory,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  const relative=path.posix.join(prefix,entry.name);if(entry.isDirectory())return filesIn(directory,relative);
  if(!entry.isFile())throw Error('Runtime package inputs must be regular files: '+relative);return [relative];
 });
}
function record(directory,relative){
 const file=path.join(directory,relative),bytes=fs.readFileSync(file),result={path:relative,size:bytes.length,mode:fs.statSync(file).mode&0o777,sha256:sha(bytes)};
 try{result.architectures=Native.readMachOArchitectures(file,{allowLibrary:true});}catch(error){if(relative===HOST||relative===SDL)throw error;}
 return result;
}
const plist=version=>`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
 <key>CFBundleDevelopmentRegion</key><string>en</string>
 <key>CFBundleDisplayName</key><string>AnyPS5</string>
 <key>CFBundleExecutable</key><string>anyps5-fex-start</string>
 <key>CFBundleIdentifier</key><string>com.maclauncher.anyps5-fex</string>
 <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
 <key>CFBundleName</key><string>AnyPS5</string>
 <key>CFBundlePackageType</key><string>APPL</string>
 <key>CFBundleShortVersionString</key><string>${version}</string>
 <key>CFBundleVersion</key><string>${version}</string>
 <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
 <key>LSMinimumSystemVersion</key><string>26.0</string>
 <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;

export async function packageRuntime({startBuild,output,version,anyps5Source}){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version||'')||!output||fs.existsSync(output))throw Error('Choose a new output directory and explicit package version.');
 for(const name of ['anyps5-fex-start','libSDL2-2.0.0.dylib'])
  if(!Native.readMachOArchitectures(path.join(startBuild,name),{allowLibrary:true}).includes('arm64'))throw Error(`${name} in the start build is not arm64.`);
 fs.mkdirSync(output,{recursive:true});const payload=path.join(output,'payload');fs.mkdirSync(payload);
 const app=path.join(payload,'AnyPS5.app');
 copy(path.join(startBuild,'libSDL2-2.0.0.dylib'),path.join(payload,SDL),0o755);
 copy(path.join(startBuild,'anyps5-fex-start'),path.join(payload,HOST),0o755);
 fs.writeFileSync(path.join(app,'Contents/Info.plist'),plist(version));
 // Nested code first, then the bundle, whose seal covers Info.plist and the library beside the host.
 run('/usr/bin/codesign',['--force','--sign','-',path.join(payload,SDL)]);
 run('/usr/bin/codesign',['--force','--sign','-',app]);
 const anyps5=anyps5Source?path.resolve(anyps5Source):path.join(root,sourceCheckout(anyps5Recipe.source)),fex=path.join(root,sourceCheckout(recipe.source));
 if(run('git',['-C',anyps5,'rev-parse','HEAD']).trim()!==sourceRevision(anyps5Recipe.source))throw Error('The AnyPS5 checkout is not at the declared revision.');
 addLicenses(payload,'anyps5',anyps5);
 addLicense(payload,'AnyPS5-ARM',path.join(root,'producers/anyps5/licenses/AnyPS5-ARM.txt'));
 addLicense(payload,'FidelityFX-FSR',path.join(anyps5,'3rdparty/FidelityFX-FSR/license.txt'));
 for(const entry of anyps5Dependencies.dependencies)addLicenses(payload,entry.path,sourceDirectory(anyps5,entry));
 addLicense(payload,'FreeType',path.join(anyps5,'3rdparty/freetype/docs/FTL.TXT'));
 addLicense(payload,'FreeType',path.join(anyps5,'3rdparty/freetype/docs/GPLv2.TXT'));
 addLicense(payload,'libjpeg-turbo',path.join(anyps5,'3rdparty/libjpeg-turbo/README.ijg'));
 addLicenses(payload,'fex',fex);
 for(const submodule of recipe.source.submodules)addLicenses(payload,'fex/'+submodule,path.join(fex,submodule));
 const digest=relative=>({path:relative,sha256:sha(fs.readFileSync(path.join(import.meta.dirname,relative)))});
 const overlays=filesIn(path.join(import.meta.dirname,'overlays')).map(relative=>digest('overlays/'+relative));
 const producerInputs=[...['build-proof.mjs','package-runtime.mjs','source.json'].map(digest),
  ...filesIn(path.join(import.meta.dirname,'host')).map(relative=>digest('host/'+relative)),...overlays].sort((a,b)=>a.path.localeCompare(b.path));
 const sources={fex:sourceProvenance(recipe.source),anyps5:sourceProvenance(anyps5Recipe.source)};
 // Each dependency's exact commit, read from the AnyPS5 checkout the licences came from (or the owned gitlink).
 const dependencies=anyps5Dependencies.dependencies.map(entry=>{
  const fields=Object.fromEntries(Object.keys(entry).filter(key=>key!=='revision').map(key=>[key,entry[key]]));
  if(entry.sourcePath)return {...fields,revision:gitlink(entry.sourcePath)};
  const parent=anyps5Dependencies.dependencies.findLast(candidate=>entry.path.startsWith(candidate.path+'/'))?.path||'';
  return {...fields,revision:run('git',['-C',path.join(anyps5,parent),'rev-parse','HEAD:'+entry.path.slice(parent?parent.length+1:0)]).trim()};
 });
 fs.writeFileSync(path.join(payload,'source.json'),json({schemaVersion:1,source:sources.fex,anyps5:sources.anyps5,overlays:recipe.overlays,
  dependencies,producerInputs}));
 const files=filesIn(payload).map(relative=>record(payload,relative));
 const manifest={schemaVersion:1,managerId:'anyps5-fex',version,platform:'darwin',arch:'arm64',minimumMacOS:'26.0',
  upstreamRevision:sourceRevision(anyps5Recipe.source),fexRevision:sourceRevision(recipe.source),gameArchitecture:'x86_64',
  capabilities:{mouseRouting:true,touchPadBinding:true},
  provenance:{sourceUrl:anyps5Recipe.source.repository,sourceRevision:sourceRevision(anyps5Recipe.source),
   fexSourceUrl:recipe.source.repository,fexSourceRevision:sourceRevision(recipe.source),producerInputs},
  executableRelative:HOST,files};
 fs.writeFileSync(path.join(payload,'runtime.json'),json(manifest));
 const manifestFile=record(payload,'runtime.json'),sourceFile=files.find(file=>file.path==='source.json');
 const declaration={id:'anyps5-fex',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:manifest.minimumMacOS,directoryRelative:'anyps5-fex/'+version+'/arm64',
  sourceRelative:'source.json',sourceSha256:sourceFile.sha256,manifestRelative:'runtime.json',manifestSha256:manifestFile.sha256,files:[...files,manifestFile],redistribution:'bundle'};
 fs.writeFileSync(path.join(output,'declaration.json'),json(declaration));
 const archive=path.join(output,assetName(declaration));
 const result=await pack({project:'anyps5-fex',input:payload,declaration,output:archive});
 return {archive,record:result};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{
  const names={'--start-build':'startBuild','--output':'output','--version':'version','--anyps5-source':'anyps5Source'},options={};
  for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index],value=process.argv[index+1];if(!value||!names[key])throw Error('Use --start-build, --output, --version and --anyps5-source.');options[names[key]]=value;}
  console.log(json(await packageRuntime(options)));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
