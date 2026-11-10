import './producer-environment.mjs';
import {addLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {buildInput} from './build-input.mjs';
import {prepareSdl} from './android-sdl3-publisher.mjs';
import {helperPackage} from './helper-package.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Keep the original publisher framework API, including the headers consumers compile against. */
export function packageSdl3Framework({project,version,output,sdl,profile}){
 const payload=path.join(output,'payload'),framework=path.join(payload,'native/SDL3.framework/Versions/A');fs.mkdirSync(path.dirname(framework),{recursive:true});
 // Keep the publisher's canonical image directory. Flattening its framework
 // aliases creates cross-directory copies with different @loader_path bases.
 const publisher=fs.realpathSync(sdl),source=fs.realpathSync(path.join(publisher,'Versions/A'));
 if(!source.startsWith(publisher+path.sep))throw Error('SDL framework version leaves its publisher input.');
 function copy(from,to,parents=[]){
  const actual=fs.realpathSync(from),stat=fs.statSync(actual);
  if(actual!==source&&!actual.startsWith(source+path.sep))throw Error('SDL framework link leaves its publisher input.');
  if(stat.isDirectory()){
   if(parents.includes(actual))throw Error('SDL framework contains a link cycle.');
   fs.mkdirSync(to,{recursive:true});for(const name of fs.readdirSync(actual))copy(path.join(actual,name),path.join(to,name),[...parents,actual]);
  }else if(stat.isFile()){fs.copyFileSync(actual,to,fs.constants.COPYFILE_FICLONE);fs.chmodSync(to,stat.mode&0o777);}
  else throw Error('SDL framework contains a non-file input.');
 }
 copy(source,framework);
 addLicenses(payload,'SDL3',path.join(source,'Resources'));
 return helperPackage({id:project,version,arch:'universal',output,minimumMacOS:'13.0',sourceSha256:profile.sha256,record:{publisherVersion:profile.version,publisherArchive:profile}});
}
/** Compile the universal SDL3 framework from its declared archive. */
export async function compile({project,arch,work}){
 if(project!=='native-sdl3'||arch!=='universal')throw Error('Select the universal SDL3 framework package.');
 const profile=JSON.parse(fs.readFileSync(path.join(root,'producers/android-inputs/common-publishers.json'))).sdl;
 fs.mkdirSync(work,{recursive:true});const archive=await buildInput(profile),sdl=await prepareSdl(archive,work,profile);
 return {sdl,profile};
}
/** Package the compiled framework. */
export async function assemble({project,version,output,compiled:{sdl,profile}}){
 return packageSdl3Framework({project,version,output,sdl,profile});
}
recipeMain(import.meta,{compile,assemble});
