import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sha} from './helper-package.mjs';
import {checkoutSource,run} from './build-source.mjs';
import {prepareArtJavaProducer} from './android-art-java-stage.mjs';
import {buildArtHwui} from './build-android-art-hwui.mjs';
import {prepareArtGuestInputs} from './android-art-guest-inputs.mjs';
import {rustEnvironment} from './rust-build.mjs';
import {readArtFfiInput} from './android-art-ffi-input.mjs';
const root=path.resolve(import.meta.dirname,'..');
const profile=JSON.parse(fs.readFileSync(new URL('../producers/android-art-inputs/supplier.json',import.meta.url)));
const read=(program,args,options={})=>execFileSync(program,args,{encoding:'utf8',...options}).trim();
const original=async(producer,file)=>import(pathToFileURL(path.join(producer,'src/modules/android',file)));
function file(value,label){if(!path.isAbsolute(value||'')||!fs.statSync(value,{throwIfNoEntry:false})?.isFile())throw Error('Missing source-built ART input: '+label);return value;}
function directory(value,label){if(!path.isAbsolute(value||'')||!fs.statSync(value,{throwIfNoEntry:false})?.isDirectory())throw Error('Missing source-built ART input: '+label);return value;}
function link(destination,source){directory(source,source);fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination))throw Error('ART build alias already exists: '+destination);fs.symlinkSync(source,destination,'dir');}
function overlay(cwd,name){run('git',['apply',path.join(root,'producers/android-art-inputs',name)],{cwd,env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(cwd)}});}

/** Export the selected ART component producer independently of HWUI's leaf source. */
export function prepareArtSupplierProducer({output}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('The ART component producer requires a new absolute export directory.');
 const android=path.join(root,profile.androidSource.directory);
 if(read('git',['-C',android,'rev-parse','HEAD'])!==profile.androidSource.revision||read('git',['-C',android,'status','--porcelain','--untracked-files=no']))throw Error('The ART component source differs from its selected revision.');
 const archive=output+'.tar';fs.mkdirSync(output,{recursive:true});
 try{
  run('git',['-C',android,'archive','--format=tar','--output='+archive,profile.androidSource.revision,'--','src','package.json']);
  run('/usr/bin/tar',['-xf',archive,'-C',output]);overlay(output,'supplier-build.patch');return output;
 }finally{fs.rmSync(archive,{force:true});}
}

/** Export the exact existing runtime projection and its retained allocator adapter without compiling. */
export async function prepareArtSupplierSource({source,klepton,glesHeaders,output}){
 const android=path.join(root,profile.androidSource.directory);
 const selected=JSON.parse(fs.readFileSync(path.join(android,'src/modules/android/art/supplier.json'))).sources.aim;
 if(read('git',['-C',source,'rev-parse','HEAD'])!==selected.commit||read('git',['-C',source,'status','--porcelain','--untracked-files=no']))throw Error('The original ART source differs from its selected immutable checkout.');
 const aim=output,{prepareAimSource}=await original(android,'art/source.mjs');
 prepareAimSource({source,output:aim,klepton,glesHeaders,mutableCode:true});
 overlay(aim,'allocator-build.patch');
 const n2=path.join(aim,'crates/aim-build/src/n2db.rs'),text=fs.readFileSync(n2,'utf8'),marker='.arg0(ARGV0)\n            .arg("-C")';
 if(text.split(marker).length!==2)throw Error('The original compiler job boundary changed.');
 fs.writeFileSync(n2,text.replace(marker,'.arg0(ARGV0)\n            .arg("-j")\n            .arg("2")\n            .arg("-C")'));
 return aim;
}

/** Preserve inherited toolchain flags while mapping the supplier's own source and target paths. */
export function artSupplierBuildEnvironment({work,target,sdk,python,env=process.env}){
 const result=rustEnvironment({work,minimumMacOS:env.MACOSX_DEPLOYMENT_TARGET||'13.0',env});
 return {...result,CARGO_TARGET_DIR:target,CARGO_BUILD_JOBS:'2',ANDROID_SDK_ROOT:sdk,PATH:path.dirname(python)+path.delimiter+(env.PATH||'')};
}

/** Build the complete existing ART supplier from source-built common and ELF inputs. */
export async function buildAndroidArtSupplier({common,elf,ffiInput,artJava,output,work}){
 if(process.platform!=='darwin'||process.arch!=='arm64'||[output,work].some(value=>!path.isAbsolute(value||'')||fs.existsSync(value))||!common?.tools||!elf?.build)throw Error('The ART supplier requires source-built common/ELF results and new absolute output/work paths on Apple Silicon macOS.');
 const android=path.join(root,profile.androidSource.directory);
 if(read('git',['-C',android,'rev-parse','HEAD'])!==profile.androidSource.revision||read('git',['-C',android,'status','--porcelain','--untracked-files=no']))throw Error('The ART supplier producer differs from its declared source.');
 const sourceProfile=JSON.parse(fs.readFileSync(path.join(android,'src/modules/android/art/supplier.json'))),inputsProfile=JSON.parse(fs.readFileSync(path.join(root,'producers/android-inputs/aim.json')));
 if(elf.record?.aimRevision!==sourceProfile.sources.aim.commit)throw Error('ART ELF and supplier inputs select different original AIM revisions.');
 const ffi=readArtFfiInput(ffiInput);if(ffi.revision!==sourceProfile.sources.libffi.commit)throw Error('The Linux libffi input differs from the original ART source.');
 directory(elf.art,'compiled ART ELF input');directory(elf.build.fetched,'original ELF compiler inputs');directory(elf.build.checkout,'selected original AIM source');
 fs.mkdirSync(work,{recursive:true});
 const producer=prepareArtSupplierProducer({output:path.join(work,'producer')});
 const javaInput=prepareArtJavaProducer({producer,input:artJava,work});
 const commonReceipt=JSON.parse(fs.readFileSync(path.join(common.build,'build-receipt.json')));
 if(javaInput.manifest.frameworkInputSha256!==commonReceipt.inputs?.javaFramework)throw Error('The ART Java input and common framework select different sealed products.');
 const glesHeaders=directory(common.sources.glesHeaders||common.sources['gles-headers'],'GLES declarations');
 const aim=await prepareArtSupplierSource({source:elf.build.checkout,klepton:directory(common.sources.klepton,'Klepton source'),glesHeaders,output:path.join(work,'aim-source')});
 const target=path.join(work,'aim-target');fs.mkdirSync(target);link(path.join(aim,'target'),target);link(path.join(aim,'_build'),elf.build.fetched);
 const env=artSupplierBuildEnvironment({work,target,sdk:elf.build.sdk,python:elf.build.python,env:elf.build.env});
 const ndk=directory(path.join(elf.build.sdk,'ndk',inputsProfile.ndk.version),'original NDK'),bin=path.join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin');
 const graph=(...names)=>run('cargo',['run','--offline','--locked','--release','--quiet','--package','aim-build','--bin','cargo-aim','--','build','--jobs','2',...names],{cwd:aim,env});
 const mount=path.join(elf.build.fetched,'android16-image'),wasMounted=fs.existsSync(path.join(mount,'root.identity'));
 try{
 run('cargo',['fetch','--locked'],{cwd:aim,env});
 graph('image');
 const image={root:directory(path.join(mount,'root'),'original Android image'),contentSha256:profile.originalImage.content.sha256};
 const {imageContentIdentity}=await original(android,'art/build.mjs'),identity=imageContentIdentity(image.root);
 if(JSON.stringify(identity)!==JSON.stringify(profile.originalImage.content))throw Error('The original Android image content identity differs from its selected ABI.');
 graph(...profile.halTargets);
 const halRoot=path.join(work,'hal'),halManifests=path.join(work,'hal-manifests');fs.mkdirSync(halRoot);fs.mkdirSync(halManifests);
 for(const name of profile.halFiles)fs.copyFileSync(file(path.join(target,'aarch64-linux-android/android',name),'original HAL '+name),path.join(halRoot,name));
 for(const relative of profile.halManifests)fs.copyFileSync(file(path.join(aim,relative),'original HAL manifest'),path.join(halManifests,path.basename(relative)));
 const hwui=await buildArtHwui({common,image,ndk,work:path.join(work,'hwui')});
 const guest=await prepareArtGuestInputs({common,hwui,image,ndk,work:path.join(work,'guest-inputs')});
 const libffi=checkoutSource({repository:sourceProfile.sources.libffi.url,revision:sourceProfile.sources.libffi.commit,destination:path.join(work,'libffi')});
 const {arm32BuildProducts}=await original(producer,'native/arm32/components.mjs');
 const arm32=arm32BuildProducts(directory(common.arm32Work,'common ARM32 compiler outputs')),arm32Inputs=common.arm32Inputs;
 if(!arm32Inputs)throw Error('The common compiler must expose its original ARM32 declarations, syscalls and format products.');
 const graphicsProfile=JSON.parse(fs.readFileSync(path.join(android,'src/modules/android/native/gles-headers.json'))).registry,graphicsRegistry=file(path.join(glesHeaders,graphicsProfile.path),'original GLES XML registry');
 if(fs.statSync(graphicsRegistry).size!==graphicsProfile.size||sha(graphicsRegistry)!==graphicsProfile.sha256)throw Error('The original GLES XML registry differs from its declared source.');
 const imports={directory:directory(arm32Inputs.importsDirectory,'ARM32 declarations'),syscalls:directory(arm32Inputs.syscalls,'ARM32 syscalls'),format:directory(arm32Inputs.format,'ARM32 format'),graphicsRegistry};
 const unicornProfile=JSON.parse(fs.readFileSync(path.join(android,'src/modules/android/native/arm64/unicorn-source.json')));
 const unicorn=checkoutSource({repository:unicornProfile.url,revision:unicornProfile.revision,destination:path.join(work,'unicorn')});
 const libraryDirectories=[path.join(image.root,'system/lib64'),...fs.readdirSync(path.join(image.root,'apex')).map(name=>path.join(image.root,'apex',name,'lib64')).filter(file=>fs.statSync(file,{throwIfNoEntry:false})?.isDirectory())];
 const rustGuest={aim,env,linker:path.join(bin,'aarch64-linux-android35-clang'),libraryDirectories,aidl:common.tools.aidl,python:common.tools.python};
 const java={prebuilt:artJava};
 const {buildArt}=await original(producer,'art/build.mjs');
 const manifest=await buildArt({output,host:{aim,klepton:common.sources.klepton,sdl:common.sdl,jni:common.tools.jdk,ninja:common.tools.ninja,python:common.tools.python,env},
  runner:{aim,unicorn,jobs:2,env},guest:{...guest,libraryDirectories},sensors:rustGuest,composer:rustGuest,graphics:rustGuest,
  nativeBridge:{ndk,ffi,imports,ninja:common.tools.ninja,python:common.tools.python,bionicSource:common.sources['bionic-source'],artSource:common.sources['art-source'],image:image.root,arm32},java,
  inputs:{image:image.root,art:elf.art,linuxTranslate:file(path.join(elf.build.target,'release/linux-translate'),'original source-built image translator'),halRoot,halManifests,
   vendorManifest:file(path.join(aim,'image/vendor/etc/vintf/manifest.xml'),'original derived vendor manifest'),hwuiLibrary:hwui.path,hwuiNotices:hwui.notices},
  bootClasspath:profile.bootClasspath,includeImage:false,originalImage:profile.originalImage});
 const sourceArchiveInputs={sources:{source:elf.build.checkout,klepton:common.sources.klepton,glesHeaders,aosp:path.join(elf.build.fetched,'aosp'),xsdc:path.join(elf.build.fetched,'xsdc')},unicorn,
  sourceCheckouts:{'aosp-native':common.sources['native-source'],'aosp-bionic':common.sources['bionic-source'],'aosp-art':common.sources['art-source'],libffi,dynarmic:common.sources['dynarmic-source']},
  nativeBridgeSources:{ndkHeaders:arm32Inputs.ndkHeaders,arm32Notices:arm32.notices},hwuiSources:{sources:hwui.sources,registry:path.join(hwui.notices,'SOURCES.json'),registryCache:path.join(hwui.tools.cargoHome,'registry/cache')}};
 return {root:path.join(output,'runtime'),manifest,originalImage:profile.originalImage,sourceArchiveInputs,build:{producer,aim,hwui,guest,libffi,unicorn,java,halRoot,halManifests},record:{androidSource:profile.androidSource,aimRevision:sourceProfile.sources.aim.commit,unicornRevision:unicornProfile.revision,libffiRevision:sourceProfile.sources.libffi.commit}};
 }finally{if(!wasMounted&&fs.existsSync(path.join(mount,'root.identity')))run('hdiutil',['detach',mount]);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.length!==4||process.argv[2]!=='--inputs'||!path.isAbsolute(process.argv[3]))throw Error('Use --inputs with an absolute source-built input record.');
 buildAndroidArtSupplier(JSON.parse(fs.readFileSync(process.argv[3]))).then(({build,...result})=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
}
