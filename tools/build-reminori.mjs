import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildInput} from './build-input.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {rustEnvironment,rustNotices} from './rust-build.mjs';
import {rustLicenseInputs} from './rust-license-inputs.mjs';
import {recipeMain} from './build-source.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Builder=require('../producers/maclauncher/src/modules/minori/runtime/build.js');
const Movies=require('../producers/maclauncher/src/modules/minori/runtime/movie-build.js');
const Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native.js');
export async function buildMinori({project,arch,output,work}) {
 fs.mkdirSync(work,{recursive:true});
 const sourceDir=path.join(root,'producers/maclauncher/src/external/ReMinori'),prefix=path.join(work,'movies');
 const archive=await buildInput(Movies.SOURCE);
 await Movies.buildMovieDependencies({archive,destination:prefix,architecture:arch});
 process.env.CARGO_HOME=path.join(work,'cargo');const env={...process.env};
 const sdk=process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();
 const built=await Builder.buildCandidate({sourceDir,destination:path.join(work,'compiled'),decoderPrefix:prefix,architecture:arch,dependencies:{prepareCargo:({sourceRoot,env:buildEnv,target})=>execFileSync('cargo',['fetch','--locked','--target',target],{cwd:sourceRoot,env:{...buildEnv,CARGO_HOME:env.CARGO_HOME},stdio:'inherit',timeout:900000}),runBuildCommand:async(command,args,options)=>{
  const Build=require('../producers/maclauncher/src/modules/shared/runtime/pinned-native-build.js');
  const mapped=rustEnvironment({work,minimumMacOS:'13.0',env:{...env,...options.env,CARGO_HOME:env.CARGO_HOME}});
  return Build.runBuildCommand(command,['clang','clang++'].includes(path.basename(command))?['-isysroot',sdk,...args]:args,{...options,env:{...mapped,CARGO_TARGET_DIR:options.env?.CARGO_TARGET_DIR}});
 }}});
 const licenses=await rustLicenseInputs({file:path.join(root,'producers/reminori/licenses.json'),output:path.join(work,'license-inputs')});
 const notices=[{file:path.join(sourceDir,'LICENSE'),name:'ReMinori',license:'AGPL-3.0-only',sourceUrl:'https://github.com/luoyily/ReMinori'},
 {file:path.join(prefix,'FFmpeg-LICENSE.txt'),name:'FFmpeg 7.1.2',license:'LGPL-2.1-or-later',sourceUrl:'https://ffmpeg.org'},...rustNotices({source:built.sourceRoot,output:path.join(work,'notices'),target:arch==='x64'?'x86_64-apple-darwin':'aarch64-apple-darwin',env,licenseInputs:licenses.licenseInputs})];
 const raw=built.directory,payloads=['profile.json','lib','bin/maclauncher-minori-probe','bin/maclauncher-minori-movie'].map(relative=>({source:path.join(raw,relative),relative}));
 return sealRuntime({project,arch,output,executable:built.executablePath,sourceRoot:sourceDir,upstreamRevision:Builder.REVISION,payloads,notices,provenance:{crateLicenseInputs:licenses.provenance},
  runtimeFiles:{profile:'profile.json',probe:'bin/maclauncher-minori-probe',movieDecoder:'bin/maclauncher-minori-movie'},
  jsonMetadata:{'profile.json':(profile,{files})=>({...profile,executables:Object.fromEntries(Object.keys(profile.executables).map(name=>[name,Native.hashFile(path.join(files,'bin',name))])),movieDecoder:{...profile.movieDecoder,sha256:Native.hashFile(path.join(files,'bin/maclauncher-minori-movie')),files:profile.movieDecoder.files.map(row=>({...row,sha256:Native.hashFile(path.join(files,row.path))}))}})}});
}
recipeMain(import.meta,buildMinori);
