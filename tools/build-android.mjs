import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {recipeMain} from './build-source.mjs';
import {verifyProducer} from './build-runtime.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {androidBuildInputRequirements,verifyAndroidBuildInput,resolveAndroidSignedInputs} from './android-signed-inputs.mjs';
import {prepareArtMacBuildContext} from './android-art-mac-context.mjs';
import {prepareArtOriginalImage} from './android-art-image-volume.mjs';
import {buildAndroidCommonInput} from './build-android-common.mjs';
import {buildAndroidArtSupplier} from './build-android-art-supplier.mjs';
import {repackageAndroid} from './repackage-android.mjs';
import {packageAndroid} from './package-android.mjs';
const root=path.resolve(import.meta.dirname,'..');
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),Contract=require('../lib/package-contract.cjs');
const {readMachOLoadCommands}=require('../producers/maclauncher/src/modules/shared/runtime/macho-load-commands.js');
const json=file=>JSON.parse(fs.readFileSync(file));
function product(root,relative){const file=path.join(root,relative);if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile())throw Error('The sealed Android input is missing '+relative);return file;}

/** Adapt ordinary sealed groups to the unchanged common and ART producer APIs. */
export function androidBuildInputViews(inputs){
 const checked={};for(const requirement of androidBuildInputRequirements())checked[requirement.key]=verifyAndroidBuildInput(requirement,inputs[requirement.key]);
 const angleDefinition=json(path.join(root,'producers/android-inputs/angle.json')),profile=angleDefinition.profiles.find(profile=>profile.id==='common'),angleManifest=json(product(checked.angle.root,'angle-manifest.json'));
 if(angleManifest.version!==profile.providerVersion||angleManifest.programBinaryVersion!==profile.programBinaryVersion||angleManifest.angleRevision!==angleDefinition.angle.revision)throw Error('The Android ANGLE input differs from its common profile.');
 return {checked,angle:{angle:checked.angle.root,angleNotices:path.join(checked.angle.root,'notices')},
  codecs:{codecs:path.join(checked.codecs.root,'codecs'),codecNotices:path.join(checked.codecs.root,'notices'),include:path.join(checked.codecs.root,'include')},
  blueprint:{parser:product(checked.blueprint.root,'bin/android-blueprint-parser'),sources:product(checked.blueprint.root,'parser-sources.json')},
  aconfig:product(checked.aconfig.root,'files/bin/aconfig'),extractor:product(checked.extractor.root,'files/bin/android-image-extract'),
  java:checked.java.root,javaFramework:checked.javaFramework.root,artJava:checked.artJava.root,ffiInput:path.dirname(checked.ffi.root),
  imageInputs:androidBuildInputRequirements().filter(requirement=>requirement.key.startsWith('image')).map(requirement=>path.dirname(checked[requirement.key].root))};
}

/** Assemble validated producer inputs; local wiring checks use the same sealed products. */
export async function buildAndroidFromInputs({version,arch,output,work,inputs}){
 const views=androidBuildInputViews(inputs),recipe=json(path.join(root,'runtimes/android/source.json')),android=verifyProducer(root,recipe),child=name=>path.join(work,name);
 const elf=await prepareArtMacBuildContext({elfInput:views.checked.elf,work:child('art-context')});
 const image=await prepareArtOriginalImage({inputs:views.imageInputs,elf,work:child('original-image')});let attached=true;
 try{
  const platform=json(path.join(android,'src/modules/android/native/platform-packages-binary.json')),platformPackages=child('platform-packages');fs.mkdirSync(platformPackages);
  if(platform.files.length!==1)throw Error('The original image package profile changed.');
  fs.copyFileSync(path.join(image.root,platform.suppliedImage.component),path.join(platformPackages,platform.files[0].path),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
  const common=await buildAndroidCommonInput({version,output:child('common-output'),work:child('common-work'),angle:views.angle,codecs:views.codecs,blueprint:views.blueprint,aconfig:views.aconfig,platformPackages,java:views.java,javaFramework:views.javaFramework});
  const supplier=await buildAndroidArtSupplier({common,elf,ffiInput:views.ffiInput,artJava:views.artJava,output:child('supplier-output'),work:child('supplier-work')});
  const {exportArtSourceArchive}=await import(pathToFileURL(path.join(android,'src/modules/android/art/source-archive.mjs')));
  const sourceArchive=exportArtSourceArchive({...supplier.sourceArchiveInputs,output:child('art-source.tar.gz')});
  const {packageArtAdapter}=await import(pathToFileURL(path.join(android,'src/modules/android/art/package.mjs')));
  const packaged=packageArtAdapter({supplierRoot:supplier.root,commonRoot:common.root,commonDeclaration:common.declaration,extractor:views.extractor,sourceArchive,originalImage:supplier.originalImage,version,output:child('art-package')},
   {...Contract,fileInventory:B.fileInventory,versionAtLeast:B.versionAtLeast,verifyPayload:B.verifyPayload,readMachOLoadCommands});
  const artRoot=child('art-runtime'),artDeclaration=repackageAndroid({input:packaged.root,declaration:packaged.declaration,output:artRoot});
  const result=packageAndroid({commonRoot:common.root,commonDeclaration:common.declaration,artRoot,artDeclaration,version,output});
  if(json(path.join(result.output,'payload/runtime.json')).capabilities?.artExecutionVersion!==1)throw Error('The unified Android package has no ART capability.');
  image.detach();attached=false;fs.rmSync(work,{recursive:true});return result;
 }finally{if(attached)image.detach();}
}

/** Build both engines once, consuming exact signed inputs before any compiler runs. */
export async function buildAndroid({project,version,arch,output,work}){
 if(project!=='android')throw Error('Select the Android project.');
 const declared=buildRecord(resolveProject(project,root),version);version=declared.version;
 if(!declared.architectures.includes(arch)||[output,work].some(file=>!path.isAbsolute(file||'')||fs.existsSync(file)))throw Error('Select the declared Android CPU and new absolute output/work directories.');
 const target=path.resolve(output),workspace=path.resolve(work);
 if(target===workspace||target.startsWith(workspace+path.sep)||workspace.startsWith(target+path.sep))throw Error('Android output and compiler work must be separate directories.');
 verifyProducer(root,json(path.join(root,'runtimes/android/source.json')));fs.mkdirSync(work,{recursive:true});
 const inputs=await resolveAndroidSignedInputs({work:path.join(work,'inputs')});
 return buildAndroidFromInputs({version,arch,output,work,inputs});
}
recipeMain(import.meta,buildAndroid);
