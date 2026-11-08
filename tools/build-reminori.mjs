import './producer-environment.mjs';
import {addLicenses} from '../lib/licenses.mjs';
import {retryNetwork} from './download.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildInput} from './build-input.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {rustEnvironment} from "./rust-build.mjs";

import {recipeMain} from './build-source.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Builder=require('../producers/package-support/src/modules/minori/runtime/build.js');
const Movies=require('../producers/package-support/src/modules/minori/runtime/movie-build.js');
const Native=require('../sources/maclauncher/src/modules/shared/runtime/local-native.js');
export async function buildMinori({project,arch,output,work}) {
 fs.mkdirSync(work,{recursive:true});
 const sourceDir=path.join(root,'producers/package-support/src/external/ReMinori'),prefix=path.join(work,'movies');
 const archive=await buildInput(Movies.SOURCE);
 await Movies.buildMovieDependencies({archive,destination:prefix,architecture:arch});
 const env=rustEnvironment({work,minimumMacOS:'13.0'});
 const sdk=process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{maxBuffer:Infinity,encoding:'utf8'}).trim();
 const built=await Builder.buildCandidate({sourceDir,destination:path.join(work,'compiled'),decoderPrefix:prefix,architecture:arch,dependencies:{prepareCargo:({sourceRoot,env:buildEnv,target})=>retryNetwork(()=>execFileSync('cargo',['fetch','--locked','--target',target],{maxBuffer:Infinity,cwd:sourceRoot,env:rustEnvironment({work,minimumMacOS:'13.0',env:buildEnv}),stdio:['inherit','inherit','pipe'],timeout:900000})),runBuildCommand:async(command,args,options)=>{
  const Build=require('../sources/maclauncher/src/modules/shared/runtime/pinned-native-build.js');
  const mapped=rustEnvironment({work,minimumMacOS:'13.0',env:{...env,...options.env}});
  return Build.runBuildCommand(command,['clang','clang++'].includes(path.basename(command))?['-isysroot',sdk,...args]:args,{...options,env:{...mapped,CARGO_TARGET_DIR:options.env?.CARGO_TARGET_DIR}});
 }}});

 addLicenses(built.sourceRoot,project,path.join(root,'sources/maclauncher/src/modules/minori/runtime'));
 const raw=built.directory,payloads=['profile.json','lib','bin/maclauncher-minori-probe','bin/maclauncher-minori-movie'].map(relative=>({source:path.join(raw,relative),relative}));
 return sealRuntime({cargoRoot:built.sourceRoot,env,project,arch,output,executable:built.executablePath,sourceRoot:sourceDir,upstreamRevision:Builder.REVISION,payloads,provenance:{},runtimeFiles:{profile:'profile.json',probe:'bin/maclauncher-minori-probe',movieDecoder:'bin/maclauncher-minori-movie'},jsonMetadata:{'profile.json':(profile,{files})=>({...profile,executables:Object.fromEntries(Object.keys(profile.executables).map(name=>[name,Native.hashFile(path.join(files,'bin',name))])),movieDecoder:{...profile.movieDecoder,sha256:Native.hashFile(path.join(files,'bin/maclauncher-minori-movie')),files:profile.movieDecoder.files.map(row=>({...row,sha256:Native.hashFile(path.join(files,row.path))}))}})}});
}
recipeMain(import.meta,buildMinori);
