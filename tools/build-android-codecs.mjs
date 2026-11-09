import './producer-environment.mjs';
import {includeLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {recipeMain} from './build-source.mjs';
import {helperPackage,sha} from './helper-package.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {nativeStackInput} from './native-stack.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Audio=require('../producers/package-support/src/modules/shared/runtime/portable-sndfile.js');
const descriptor=path.join(root,'producers/android-inputs/codecs.json');

/** Open the one sealed native audio stack as this build's codec closure. */
export async function compile({project,version,arch,output,work}){
 const profile=JSON.parse(fs.readFileSync(descriptor));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select the declared Android codec version and a new absolute output directory.');
 if(!['arm64','x64'].includes(arch)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Android codec input builds need a CPU and new absolute output/work directories.');
 if(Audio.PIN.version!==profile.sourceProfile)throw Error('The shared codec source catalog differs from this input profile.');
 return {profile,version,built:nativeStackInput(preparedBuildInput('native-sndfile'),{arch,work})};
}

/** Keep Android's codec layout and seal it for the shared Runtime build path. */
export async function assemble({project,arch,output,compiled:{profile,version,built}}){
 const payload=path.join(output,'payload'),libraries=path.join(built.prefix,'lib'),codecs=path.join(payload,'codecs');
 fs.mkdirSync(codecs,{recursive:true});
 // Retain every original loader name without stripping or signing its bytes
 // again. Common packaging converts these copies into dependency aliases.
 for(const name of fs.readdirSync(libraries).filter(name=>name.endsWith('.dylib')))fs.copyFileSync(path.join(libraries,name),path.join(codecs,name));

 includeLicenses(payload,path.join(built.prefix,'licenses'));
 fs.cpSync(path.join(built.prefix,'include'),path.join(payload,'include'),{recursive:true,dereference:true});
 const sourceIdentity={profile:Audio.PIN.version,architecture:arch,recipeSha256:built.recipeSha256,audioFormats:built.audioFormats,dependencies:Audio.PIN.dependencies};
 fs.writeFileSync(path.join(payload,'sources.json'),JSON.stringify(sourceIdentity,null,2)+'\n');
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:{sourceProfile:profile.sourceProfile,audioFormats:built.audioFormats,recipeSha256:built.recipeSha256}});
}
recipeMain(import.meta,{compile,assemble});
