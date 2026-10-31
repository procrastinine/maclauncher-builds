import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {checkoutSource,run,recipeMain} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {rustEnvironment,rustNotices} from './rust-build.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const descriptor=new URL('../producers/android-inputs/aconfig/source.json',import.meta.url);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/** Compile the original Android flag generator and its finalized SDK flag data. */
export async function buildAndroidAconfig({project,version,arch,output,work}){
 const profile=JSON.parse(fs.readFileSync(descriptor));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Select the Android flag generator, its declared version, arm64 and new absolute output/work paths.');
 fs.mkdirSync(work,{recursive:true});
 const source=checkoutSource({repository:profile.repository,revision:profile.revision,destination:path.join(work,'upstream')});
 const crate=path.join(work,'build/make/tools/aconfig');fs.mkdirSync(crate,{recursive:true});
 for(const member of profile.members)fs.cpSync(path.join(source,profile.crate,member),path.join(crate,member),{recursive:true});
 // The four original packages are the complete generator closure. Other Android
 // device tools in the upstream workspace have separate platform dependencies.
 fs.writeFileSync(path.join(crate,'Cargo.toml'),'[workspace]\nmembers='+JSON.stringify(profile.members)+'\nresolver="2"\n');
 fs.copyFileSync(new URL('../producers/android-inputs/aconfig/Cargo.lock',import.meta.url),path.join(crate,'Cargo.lock'));
 for(const input of profile.sdk.files){
  const archive=await buildInput(input),content=Buffer.from(fs.readFileSync(archive,'utf8'),'base64');
  if(sha(content)!==input.contentSha256)throw Error('Finalized SDK flags differ from their original input: '+input.path);
  const destination=path.join(work,'prebuilts/sdk',input.path);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,content);
 }
 const env=rustEnvironment({work,minimumMacOS:profile.minimumMacOS,env:{...process.env,CARGO_HOME:path.join(work,'cargo')}});
 run('cargo',['fetch','--locked','--manifest-path',path.join(crate,'Cargo.toml')],{env});
 run('cargo',['build','--offline','--locked','--release','--package','aconfig','--manifest-path',path.join(crate,'Cargo.toml'),'--jobs','2'],{env});
 return packageAndroidAconfig({project,version,arch,output,work});
}

/** Package a completed original flag-generator build with its license closure. */
export async function packageAndroidAconfig({project='android-aconfig',version,arch='arm64',output,work}){
 const profile=JSON.parse(fs.readFileSync(descriptor));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||''))throw Error('Select the declared flag-generator build and a new absolute output path.');
 const source=path.join(work,'upstream'),crate=path.join(work,'build/make/tools/aconfig');
 if(sha(fs.readFileSync(path.join(crate,'Cargo.lock')))!==sha(fs.readFileSync(new URL('../producers/android-inputs/aconfig/Cargo.lock',import.meta.url))))throw Error('The completed flag generator has a different dependency lock.');
 const license=await buildInput(profile.license),copyrights=new Set();
 const scan=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())scan(file);else if(entry.isFile()&&entry.name.endsWith('.rs'))for(const line of fs.readFileSync(file,'utf8').matchAll(/Copyright[^\n]*/g))copyrights.add(line[0].trim());}};
 for(const member of profile.members)scan(path.join(crate,member));
 if(!copyrights.size)throw Error('The Android source copyright notices are missing.');
 const copyright=path.join(work,'AOSP-copyright.txt');fs.writeFileSync(copyright,[...copyrights].sort().join('\n')+'\n');
 const env=rustEnvironment({work,minimumMacOS:profile.minimumMacOS,env:{...process.env,CARGO_HOME:path.join(work,'cargo')}});
 return sealRuntime({project,version,arch,output,sourceRoot:source,upstreamRevision:profile.revision,executable:path.join(env.CARGO_TARGET_DIR,'release/aconfig'),maximumMacOS:profile.minimumMacOS,
  notices:[{file:license,name:'Android flag generator license',license:'Apache-2.0',sourceUrl:profile.repository},{file:copyright,name:'Android source copyright notices',license:'Apache-2.0',sourceUrl:profile.repository},...rustNotices({source:crate,target:'aarch64-apple-darwin',output:path.join(work,'notices'),env})],
  provenance:{sdk:{repository:profile.sdk.repository,revision:profile.sdk.revision,files:profile.sdk.files.map(({path,contentSha256})=>({path,sha256:contentSha256}))},rustLockSha256:sha(fs.readFileSync(path.join(crate,'Cargo.lock')))}});
}
recipeMain(import.meta,buildAndroidAconfig);
