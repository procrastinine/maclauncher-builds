import {copyNotices,printWarnings} from '../lib/notices.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {recipeMain} from './build-source.mjs';
import {helperPackage,sha} from './helper-package.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {nativeStackInput} from './native-stack.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Audio=require('../producers/maclauncher/src/modules/shared/runtime/portable-sndfile.js');
const descriptor=path.join(root,'producers/android-inputs/codecs.json');

/** Keep Android's codec layout while using the one sealed native audio stack. */
export async function buildAndroidCodecsInput({output,work,arch='arm64'}){
 if(!['arm64','x64'].includes(arch)||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Android codec input builds need a CPU and new absolute output/work directories.');
 const profile=JSON.parse(fs.readFileSync(descriptor));
 if(Audio.PIN.version!==profile.sourceProfile)throw Error('The shared codec source catalog differs from this input profile.');
 const built=nativeStackInput(preparedBuildInput('native-sndfile'),{arch,work}),libraries=path.join(built.prefix,'lib'),codecs=path.join(output,'codecs'),codecNotices=path.join(output,'notices');
 fs.mkdirSync(codecs,{recursive:true});fs.mkdirSync(codecNotices);
 // Retain every original loader name without stripping or signing its bytes
 // again. Common packaging converts these copies into dependency aliases.
 for(const name of fs.readdirSync(libraries).filter(name=>name.endsWith('.dylib')))fs.copyFileSync(path.join(libraries,name),path.join(codecs,name));
 const copied=copyNotices(built.notices.map((notice,index)=>({...notice,path:'notices/'+index+'-'+path.basename(notice.file)})),{output});printWarnings(copied.warnings);const notices=copied.notices.map(({file,...notice})=>notice);
 const include=path.join(output,'include');fs.cpSync(path.join(built.prefix,'include'),include,{recursive:true,dereference:true});
 const sourceIdentity={profile:Audio.PIN.version,architecture:arch,recipeSha256:built.recipeSha256,audioFormats:built.audioFormats,dependencies:Audio.PIN.dependencies};
 fs.writeFileSync(path.join(output,'sources.json'),JSON.stringify(sourceIdentity,null,2)+'\n');
 return {codecs,codecNotices,include,sourceArchives:{},sources:built.sourceRoots,profile,notices,audioFormats:built.audioFormats,recipeSha256:built.recipeSha256};
}

/** Seal the same codec input closure for the shared Runtime build path. */
export async function buildAndroidCodecs({project,version,arch,output,work}){
 const profile=JSON.parse(fs.readFileSync(descriptor));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select the declared Android codec version and a new absolute output directory.');
 const input=await buildAndroidCodecsInput({output:path.join(output,'payload'),work,arch});
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:{sourceProfile:profile.sourceProfile,audioFormats:input.audioFormats,recipeSha256:input.recipeSha256},notices:input.notices});
}
recipeMain(import.meta,buildAndroidCodecs);
