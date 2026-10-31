import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {rustNotices,rustEnvironment} from './rust-build.mjs';
import {buildInput} from './build-input.mjs';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {adapt} from '../producers/maclauncher/src/modules/android/native/apk-metadata/adapt.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/maclauncher/src/modules/android/native/apk-metadata');
export async function buildAPK({project:id,arch,output,work}){
 const project=resolveProject(id,root),spec=JSON.parse(fs.readFileSync(path.join(base,'sources.json')));
 fs.mkdirSync(work,{recursive:true});
 try {
  const archive=await buildInput(spec.aim.archive),source=path.join(work,'source');fs.mkdirSync(source);
  const prefix='aim-'+spec.aim.revision,paths=[...spec.aim.paths,...spec.aim.licensePaths];
  execFileSync('/usr/bin/tar',['-xzf',archive,'-C',source,...paths.map(file=>prefix+'/'+file)]);
  fs.renameSync(path.join(source,prefix),path.join(source,'upstream'));
  for(const file of ['main.rs','Cargo.toml','Cargo.lock'])fs.copyFileSync(path.join(base,file),path.join(source,file));
  adapt(path.join(source,'upstream/crates/aim-apps/src'));
  const env=rustEnvironment({work,minimumMacOS:'13.0'}),target=arch==='x64'?'x86_64-apple-darwin':'aarch64-apple-darwin';
  execFileSync('cargo',['build','--release','--locked','--target',target,'--bin','android-apk-metadata'],{cwd:source,env,stdio:'inherit',timeout:900000});
  const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});const binary=path.join(payload,'android-apk-metadata');fs.copyFileSync(path.join(work,'target',target,'release/android-apk-metadata'),binary);fs.chmodSync(binary,0o755);
  execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',binary]);execFileSync('/usr/bin/codesign',['--verify','--strict',binary]);
  const notices=[];
  const copyNotice=(file,relative,name,license)=>{const target=path.join(payload,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);fs.chmodSync(target,0o644);notices.push({name,license,path:relative});};
  for(const file of spec.aim.licensePaths)copyNotice(path.join(source,'upstream',file),'licenses/aim/'+file,'AIM','Apache-2.0');
  copyNotice(path.join(root,'producers/maclauncher/LICENSE'),'licenses/maclauncher/LICENSE','MacLauncher metadata protocol','MIT');
  for(const [index,notice] of rustNotices({source,output:path.join(work,'notices'),env}).entries())copyNotice(notice.file,'licenses/dependencies/'+index+'-'+path.basename(notice.file),notice.name,notice.license);
  return helperPackage({id,version:project.build.version,arch,output,minimumMacOS:'13.0',rosettaFiles:arch==='x64'?['android-apk-metadata']:[],sourceSha256:sha(path.join(base,'main.rs')),
   record:{executable:'android-apk-metadata',upstreamRevision:spec.aim.revision,binarySha256:sha(binary),cargoLockSha256:sha(path.join(base,'Cargo.lock'))},notices});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,buildAPK);
