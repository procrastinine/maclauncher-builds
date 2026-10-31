import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {copyAndroidProducts,publishAndroidAngle,publishAndroidNotices} from './android-common-products.mjs';
import {stripAndroidFrameworkBuildInputs} from './repackage-android.mjs';
import {verifyAndroidSourceSnapshot} from '../producers/maclauncher/scripts/android-stage-sources.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),Native=require('../lib/local-native.cjs'),Contract=require('../lib/package-contract.cjs'),Staging=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const root=path.resolve(import.meta.dirname,'..'),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/** Seal the complete JVM producer output without changing launcher selections. */
export function packageAndroidCommon({build,version,sourceRevision,output}){
 if(!path.isAbsolute(build||'')||!path.isAbsolute(output||'')||fs.existsSync(output)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version||'')||version.includes('..')||!/^[a-f0-9]{40}$/.test(sourceRevision||''))throw Error('Android common packaging requires a completed build, explicit version/source revision and new absolute output.');
 const receipt=JSON.parse(fs.readFileSync(path.join(build,'build-receipt.json'))),source=path.join(build,'source');
 verifyAndroidSourceSnapshot(source,receipt);
 if(receipt.schemaVersion!==2||receipt.inputs?.sourceHash!==receipt.sourceHash||sha(JSON.stringify(receipt.inputs))!==receipt.inputHash)throw Error('The Android compiler input identity differs from its completed build.');
 const pins=JSON.parse(fs.readFileSync(path.join(source,'native/source-pins.json')));
 if(JSON.stringify(pins)!==JSON.stringify(receipt.pins))throw Error('The Android compiler source pins differ from its receipt.');
 if(pins.frameworkBaseVersion===1&&JSON.stringify(receipt.framework)!==JSON.stringify(JSON.parse(fs.readFileSync(path.join(source,'native/framework-binary.json')))))throw Error('The Android framework artifact identity differs from the completed build.');
 const {runtimeProfile}=require(path.join(source,'profile.js')),profile=runtimeProfile(pins),payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 try{
  copyAndroidProducts(build,payload,receipt.products);publishAndroidAngle(payload,receipt.products,receipt.angle);stripAndroidFrameworkBuildInputs(payload);publishAndroidNotices(payload,receipt.pathMappings||[]);
  if(receipt.framework?.nativeRuntime){
   const original=receipt.framework.nativeRuntime;
   if(original.path!=='libandroid_runtime.dylib')throw Error('Unexpected Android framework native library.');
   const verify=(relative,record)=>{const bytes=fs.readFileSync(path.join(payload,'native',relative));if(bytes.length!==record.size||sha(bytes)!==record.sha256)throw Error('The original Android framework native input changed: '+relative);};
   verify(original.path,original);
   for(const data of original.data||[]){if(!/^icudt[0-9]+l\.dat$/.test(data.path))throw Error('Unexpected Android framework native data.');verify(data.path,data);}
  }
  fs.mkdirSync(path.join(payload,'notices'),{recursive:true});fs.copyFileSync(path.join(root,'producers/maclauncher/LICENSE'),path.join(payload,'notices/MacLauncher.txt'));
  const files=[],dependencies=[];let minimumMacOS='0.0';
  for(const name of B.fileInventory(payload)){
   const file=path.join(payload,name),bytes=fs.readFileSync(file),stat=fs.statSync(file),record={path:name,size:bytes.length,mode:stat.mode&0o777,sha256:sha(bytes)};
   let architectures=[];try{architectures=Native.readMachOArchitectures(file,{allowLibrary:true});}catch{}
   if(architectures.length){
    if(!architectures.includes('arm64'))throw Error('Android native dependency lacks Apple Silicon: '+name);
    record.architectures=architectures;
    const commands=Staging.loadCommands(file);if(B.versionAtLeast(commands.minimumMacOS,minimumMacOS))minimumMacOS=commands.minimumMacOS;
    if(commands.rpaths.some(value=>!/^@(loader_path|executable_path)(?:\/|$)/.test(value)))throw Error('Unexpected Android library search path: '+name);
    const ids=new Set(Staging.libraryIds(file)),links=Staging.links(file).filter(link=>!ids.has(link));
    for(const link of links){
     if(link.startsWith('/usr/lib/')||link.startsWith('/System/Library/'))continue;
     const relative=link.startsWith('@loader_path/')?link.slice(13):link.startsWith('@rpath/')&&commands.rpaths.includes('@loader_path')?link.slice(7):null;
     if(!relative)throw Error('Android dependency is not loader-relative: '+name+' -> '+link);
     const target=path.resolve(path.dirname(file),relative);if(!target.startsWith(payload+path.sep)||!fs.lstatSync(target).isFile())throw Error('Android dependency leaves its payload: '+name);
    }
    execFileSync('/usr/bin/codesign',['--verify','--strict',file],{stdio:'pipe'});dependencies.push({file:name,links});
   }
   files.push(record);
  }
  const manifest={schemaVersion:1,version,profile,minimumMacOS,architectures:['arm64'],sourceHash:receipt.sourceHash,inputHash:receipt.inputHash,pins,dependencies,files,upstreamRevision:sourceRevision};
  Contract.validatePublicMetadata(manifest);const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(payload,'runtime.json'),bytes,{mode:0o644});
  const declaration={id:'android',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS,sourceRelative:null,sourceSha256:sha(bytes),directoryRelative:'android/'+version+'/arm64',manifestRelative:'runtime.json',manifestSha256:sha(bytes),
   files:[...files,{path:'runtime.json',size:bytes.length,mode:0o644,sha256:sha(bytes)}],notices:files.filter(file=>file.path.startsWith('notices/')&&!file.path.endsWith('.json')).map(file=>({name:file.path.slice(8).replaceAll('/',' - '),license:'See included license',path:file.path}))};
  Contract.validateDeclaration(declaration);B.verifyPayload(payload,declaration);fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});return {root:payload,declaration};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
