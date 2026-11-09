import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {recipeMain,run,checkoutSource} from './build-source.mjs';
import {prepareAndroidBuildInputs,releaseAndroidImageArchive} from './android-build-inputs.mjs';
import {buildAngleInput,angleDefinition} from './build-android-angle.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {rustEnvironment} from './rust-build.mjs';
import {stageAim} from '../producers/package-support/scripts/build-android-aim.mjs';

const root=path.resolve(import.meta.dirname,'..');
const read=(command,args,options={})=>execFileSync(command,args,{maxBuffer:Infinity,encoding:'utf8',...options}).trim();
/** Use the shared Rust toolchain maps while retaining this producer's paths and profile. */
export function aimBuildEnvironment({work,upstream,sdk,python,minimumMacOS='26.0',env=process.env}){
 const result=rustEnvironment({work,minimumMacOS,env});
 const maps=['--remap-path-prefix='+work+'=/aim-build','--remap-path-prefix='+root+'=/maclauncher-builds'];
 result.CARGO_ENCODED_RUSTFLAGS=[result.CARGO_ENCODED_RUSTFLAGS,...maps].join(String.fromCharCode(31));
 return {...result,CARGO_BUILD_JOBS:'2',SDKROOT:env.SDKROOT||read('xcrun',['--sdk','macosx','--show-sdk-path'],{env}),PATH:path.dirname(python)+path.delimiter+(env.PATH||''),CARGO_TARGET_DIR:path.join(upstream,'target'),ANDROID_SDK_ROOT:sdk,MACLAUNCHER_AIM_ROOT:upstream};
}
/** Retire only disposable stages inside this invocation's owned build directory. */
export function planAimBuildCleanup({work,complete=false}){
 if(!path.isAbsolute(work||'')||path.resolve(work)===path.parse(work).root)throw Error('AIM cleanup requires an owned absolute build directory.');
 const owned=fs.realpathSync(work),inside=file=>file.startsWith(owned+path.sep);
 const relative=complete?['inputs','cargo','upstream/target','upstream/_build','angle-build','angle']:[
  'inputs','upstream/target/release','upstream/target/aarch64-linux-android',
  ...['deps','build','incremental','.fingerprint','examples'].map(name=>'upstream/target/aim-host-build/release/'+name),
  ...['obj','gen','src','bin','lib64'].map(name=>'upstream/target/aim/art/'+name),
  'upstream/_build/android16-image.dmg'
 ];
 return relative.map(name=>path.join(owned,name)).filter(file=>fs.existsSync(file)).map(file=>{
  if(fs.lstatSync(file).isSymbolicLink()||!inside(fs.realpathSync(file)))throw Error('An AIM cleanup input is outside its owned build directory.');
  return file;
 });
}
export function cleanupAimBuild(options){
 const remove=planAimBuildCleanup(options);
 for(const file of remove)fs.rmSync(file,{recursive:true,force:true});
 return remove;
}
function detachAimImage(work,upstream){
 const mount=path.join(upstream,'_build/android16-image');
 if(!fs.existsSync(mount))return;
 if(!fs.realpathSync(mount).startsWith(fs.realpathSync(work)+path.sep))throw Error('The AIM image mount is outside its owned build directory.');
 if(fs.statSync(mount).dev!==fs.statSync(path.dirname(mount)).dev)run('hdiutil',['detach',mount]);
}
/** Reuse the common adapted ANGLE input for AIM's existing graphics boundary. */
export function aimAngleInput(input){
 const definition=angleDefinition(),profile=definition.profiles.find(row=>row.id==='common');
 const manifest=JSON.parse(fs.readFileSync(path.join(input.root,'angle-manifest.json')));
 if(input.record?.id!==definition.id||input.record.version!==profile.version||manifest.version!==profile.providerVersion||manifest.angleRevision!==definition.angle.revision)throw Error('The shared AIM ANGLE input differs from its original profile.');
 return {angle:input.root,manifest,profileId:'common'};
}
/** Build the existing AIM adaptation and seal it without changing app declarations. */
export async function buildAndroidAim({project,version,arch,output,work}){
 const ownedWork=path.resolve(work),ownedOutput=path.resolve(output);
 if(ownedWork===ownedOutput||ownedOutput.startsWith(ownedWork+path.sep)||ownedWork.startsWith(ownedOutput+path.sep))throw Error('AIM output and build directories must be separate.');
 const selected=resolveProject(project,root),record=buildRecord(selected,version);
 version=record.version;
 const {source,prepareAimSources}=await import(pathToFileURL(path.join(root,'producers/package-support/src/modules/android/providers/aim/source.mjs')));
 const upstream=path.join(work,'upstream');
 const checkout=checkoutSource({repository:source.repository,revision:source.revision,destination:path.join(work,'aim-source')});
 if(read('git',['-C',checkout,'rev-parse','HEAD'])!==source.revision||read('git',['-C',checkout,'status','--porcelain','--untracked-files=no']))throw Error('AIM sources differ from their declared clean revision.');
 fs.mkdirSync(work,{recursive:true});
 prepareAimSources({checkout,output:upstream,controllerSource:path.join(root,'producers/android-aim-controller/keeper.rs'),buildJobs:2});
 const {sdk,python,cache}=await prepareAndroidBuildInputs({source:upstream,work:path.join(work,'inputs'),image:source.androidImage});
 const env=aimBuildEnvironment({work,upstream,sdk,python,minimumMacOS:source.minimumMacOS||'26.0'});
 try{
 run(process.execPath,[path.join(root,'producers/package-support/scripts/build-android-aim.mjs'),'--build','--image-only','--jobs','2','--work',upstream],{env});
 await releaseAndroidImageArchive({source:upstream,work,cache,image:source.androidImage});
 run(process.execPath,[path.join(root,'producers/package-support/scripts/build-android-aim.mjs'),'--build','--jobs','2','--work',upstream],{env});
 }finally{detachAimImage(work,upstream);}
 // Compilation is complete. Staging reads detached runtime products, metadata and notices.
 cleanupAimBuild({work});
 const preparedAngle=preparedBuildInput('android-angle');
 const angle=preparedAngle?aimAngleInput(preparedAngle):await buildAngleInput({output:path.join(work,'angle'),work:path.join(work,'angle-build'),profile:'common'});
 fs.mkdirSync(output,{recursive:true});
 try{
  // stageAim owns this runtime's existing overlay, service-ABI and native metadata.
  const staged=stageAim({build:upstream,...angle,output:path.join(output,'payload'),writeDistribution:false,environment:env,version});
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(staged.declaration,null,2)+'\n',{flag:'wx'});
  cleanupAimBuild({work,complete:true});
  return {project,version,arch,output};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
recipeMain(import.meta,buildAndroidAim);
