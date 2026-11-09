import './producer-environment.mjs';
import {addLicenses,addLicense} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {copyAndroidProducts,publishAndroidAngle} from './android-common-products.mjs';
import {stripAndroidFrameworkBuildInputs} from './repackage-android.mjs';
import {verifyAndroidSourceSnapshot} from '../producers/package-support/scripts/android-stage-sources.mjs';
const require=createRequire(import.meta.url),B=require('../lib/package-format.cjs'),Native=require('../lib/package-format.cjs'),Contract=require('../lib/package-contract.cjs'),Staging=require('../producers/package-support/scripts/native-binary-tools.cjs');
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
  copyAndroidProducts(build,payload,receipt.products);publishAndroidAngle(payload,receipt.products,receipt.angle);stripAndroidFrameworkBuildInputs(payload);
  if(receipt.framework?.nativeRuntime){
   const original=receipt.framework.nativeRuntime;
   const verify=(relative,record)=>{const bytes=fs.readFileSync(path.join(payload,'native',relative));if(bytes.length!==record.size||sha(bytes)!==record.sha256)throw Error('The original Android framework native input changed: '+relative);};
   verify(original.path,original);
   for(const data of original.data||[]){verify(data.path,data);}
  }
  addLicenses(payload,'MacLauncher',root);
  addLicenses(payload,'SDL3',path.join(payload,'native/SDL3.framework/Versions/A/Resources'));
  addLicense(payload,'ASM',new URL('../producers/android-inputs/licenses/asm/LICENSE',import.meta.url));
  addLicense(payload,'AOSP framework',new URL('../producers/android-inputs/licenses/aosp-framework/LICENSE',import.meta.url));
  addLicense(payload,'Apache HTTP',new URL('../producers/android-inputs/licenses/aosp-apache-http/NOTICE',import.meta.url));
  addLicense(payload,'Robolectric portability',new URL('../producers/android-inputs/licenses/robolectric-portability/LICENSE',import.meta.url));
  addLicense(payload,'fmt',new URL('../producers/android-inputs/licenses/aosp-fmt/LICENSE',import.meta.url));
  addLicense(payload,'fmt',new URL('../producers/android-inputs/licenses/aosp-fmt/NOTICE',import.meta.url));
  addLicense(payload,'libbase',new URL('../producers/android-inputs/licenses/aosp-libbase/NOTICE',import.meta.url));
  addLicense(payload,'AOSP native',new URL('../producers/android-inputs/licenses/aosp-native/NOTICE',import.meta.url));
  addLicense(payload,'Android platform packages',new URL('../producers/android-inputs/licenses/platform-packages/NOTICE',import.meta.url));
  addLicense(payload,'XmlPull',new URL('../producers/android-inputs/licenses/xmlpull/LICENSE',import.meta.url));
  addLicense(payload,'GLES SGI-B 2.0',path.join(root,'producers/android-inputs/licenses/GLES-SGI-B-2.0.txt'));

  const files=[],dependencies=[];let minimumMacOS='0.0';
  for(const name of B.fileInventory(payload)){
   const file=path.join(payload,name),bytes=fs.readFileSync(file),stat=fs.statSync(file),record={path:name,size:bytes.length,mode:stat.mode&0o777,sha256:sha(bytes)};
   let architectures=[];try{architectures=Native.readMachOArchitectures(file,{allowLibrary:true});}catch{}
   if(architectures.length){
    record.architectures=architectures;
    const commands=Staging.loadCommands(file);if(B.versionAtLeast(commands.minimumMacOS,minimumMacOS))minimumMacOS=commands.minimumMacOS;
    const ids=new Set(Staging.libraryIds(file)),links=Staging.links(file).filter(link=>!ids.has(link));
    dependencies.push({file:name,links});
   }
   files.push(record);
  }
  const manifest={schemaVersion:1,version,profile,minimumMacOS,architectures:['arm64'],sourceHash:receipt.sourceHash,inputHash:receipt.inputHash,pins,dependencies,files,upstreamRevision:sourceRevision};
  Contract.validatePublicMetadata(manifest);const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(payload,'runtime.json'),bytes,{mode:0o644});
  const declaration={id:'android',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS,sourceRelative:null,sourceSha256:sha(bytes),directoryRelative:'android/'+version+'/arm64',manifestRelative:'runtime.json',manifestSha256:sha(bytes),
   files:[...files,{path:'runtime.json',size:bytes.length,mode:0o644,sha256:sha(bytes)}]};
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});return {root:payload,declaration};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
