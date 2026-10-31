import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {recipeMain,run} from './build-source.mjs';
import {prepareAndroidBuildInputs,releaseAndroidImageArchive} from './android-build-inputs.mjs';
import {buildAngleInput} from './build-android-angle.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {rustEnvironment} from './rust-build.mjs';
import {stageAim} from '../producers/maclauncher/scripts/build-android-aim.mjs';

const root=path.resolve(import.meta.dirname,'..');
const producer=path.join(root,'producers/maclauncher');
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',...options}).trim();
/** Use the shared Rust toolchain maps while retaining this producer's paths and profile. */
export function aimBuildEnvironment({work,upstream,sdk,python,minimumMacOS='26.0',env=process.env}){
 const cargo=path.join(work,'cargo'),result=rustEnvironment({work,minimumMacOS,env:{...env,CARGO_HOME:cargo}});
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
/** Build the existing AIM adaptation and seal it without changing app declarations. */
export async function buildAndroidAim({project,version,arch,output,work}){
 const ownedWork=path.resolve(work),ownedOutput=path.resolve(output);
 if(ownedWork===ownedOutput||ownedOutput.startsWith(ownedWork+path.sep)||ownedWork.startsWith(ownedOutput+path.sep))throw Error('AIM output and build directories must be separate.');
 const selected=resolveProject(project,root),record=buildRecord(selected,version);
 version=record.version;
 const source=JSON.parse(fs.readFileSync(path.join(producer,'src/modules/android/providers/aim/source.json')));
 const upstream=path.join(work,'upstream');
 const checkout=path.join(producer,'src/external/aim');
 if(read('git',['-C',checkout,'rev-parse','HEAD'])!==source.commit||read('git',['-C',checkout,'status','--porcelain','--untracked-files=no']))throw Error('AIM sources differ from their declared clean revision.');
 fs.mkdirSync(work,{recursive:true});
 const {prepareAimSources}=await import(pathToFileURL(path.join(producer,'src/modules/android/providers/aim/source.mjs')));
 prepareAimSources({checkout,output:upstream,controllerSource:path.join(root,'producers/android-aim-controller/keeper.rs'),buildJobs:2});
 const {sdk,python,cache}=await prepareAndroidBuildInputs({source:upstream,work:path.join(work,'inputs'),image:source.androidImage});
 const env=aimBuildEnvironment({work,upstream,sdk,python,minimumMacOS:source.minimumMacOS||'26.0'});
 try{
 run(process.execPath,[path.join(producer,'scripts/build-android-aim.mjs'),'--build','--image-only','--jobs','2','--work',upstream],{env});
 await releaseAndroidImageArchive({source:upstream,work,cache,image:source.androidImage});
 run(process.execPath,[path.join(producer,'scripts/build-android-aim.mjs'),'--build','--jobs','2','--work',upstream],{env});
 }finally{detachAimImage(work,upstream);}
 // Compilation is complete. Staging reads detached runtime products, metadata and notices.
 cleanupAimBuild({work});
 const angle=await buildAngleInput({output:path.join(work,'angle'),work:path.join(work,'angle-build'),profile:'aim6'});
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
