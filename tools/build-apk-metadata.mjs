import './producer-environment.mjs';
import {adapt} from '../producers/package-support/src/modules/android/native/apk-metadata/adapt.mjs';
import {aimSource} from '../lib/android-source.mjs';
import {addLicenses,addCargoLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {rustEnvironment} from "./rust-build.mjs";
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recipeMain,checkoutSource} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/package-support/src/modules/android/native/apk-metadata');
/** Compile the APK metadata reader from the declared AIM sources. */
export async function compile({project:id,arch,work}){
 const project=resolveProject(id,root),definition=JSON.parse(fs.readFileSync(path.join(base,'sources.json'))),spec={...definition,aim:{...definition.aim,...aimSource()}};
 fs.mkdirSync(work,{recursive:true});
 try {
  const upstream=checkoutSource({...spec.aim,destination:path.join(work,'aim')}),archive=path.join(work,'aim.tar.gz'),source=path.join(work,'source');fs.mkdirSync(source);
  execFileSync('git',['-C',upstream,'archive','--format=tar.gz','--prefix=aim-'+spec.aim.revision+'/', '--output='+archive,spec.aim.revision],{maxBuffer:Infinity});
  const prefix='aim-'+spec.aim.revision,paths=spec.aim.paths;
  execFileSync('/usr/bin/tar',['-xzf',archive,'-C',source,...paths.map(file=>prefix+'/'+file)],{maxBuffer:Infinity});

  fs.renameSync(path.join(source,prefix),path.join(source,'upstream'));
  for(const file of ['main.rs','Cargo.toml','Cargo.lock'])fs.copyFileSync(path.join(base,file),path.join(source,file));
  adapt(path.join(source,'upstream/crates/aim-apps/src'));
  const env=rustEnvironment({work,minimumMacOS:'13.0'}),target=arch==='x64'?'x86_64-apple-darwin':'aarch64-apple-darwin';
  execFileSync('cargo',['build','--release','--locked','--target',target,'--bin','android-apk-metadata'],{maxBuffer:Infinity,cwd:source,env,stdio:'inherit',timeout:900000});
  return {target,upstream,source,env,project,spec};
 }catch(error){fs.rmSync(work,{recursive:true,force:true});throw error;}
}
/** Sign and describe the compiled reader with its notices. */
export async function assemble({project:id,arch,output,work,compiled:{target,upstream,source,env,project,spec}}){
 try{
  const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});const binary=path.join(payload,'android-apk-metadata');fs.copyFileSync(path.join(work,'target',target,'release/android-apk-metadata'),binary);fs.chmodSync(binary,0o755);
  execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',binary],{maxBuffer:Infinity});

  addLicenses(payload,'AIM',upstream);addLicenses(payload,id,source);addCargoLicenses(payload,id,source,env);addLicenses(payload,'MacLauncher',root);

  return helperPackage({id,version:project.build.version,arch,output,minimumMacOS:'13.0',rosettaFiles:arch==='x64'?['android-apk-metadata']:[],sourceSha256:sha(path.join(base,'main.rs')),record:{executable:'android-apk-metadata',upstreamRevision:spec.aim.revision,binarySha256:sha(binary)}});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,{compile,assemble});
