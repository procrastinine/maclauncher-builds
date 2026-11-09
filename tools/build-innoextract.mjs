import './producer-environment.mjs';
import {addLicenses} from '../lib/licenses.mjs';
import {recipeMain} from './build-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildInput} from './build-input.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Builder=require('../producers/package-support/src/modules/shared/installers/runtime/innoextract-build.js');
/** Compile innoextract and the inspector against the shared Boost headers. */
export async function compile({arch,work,sources={},sdkPath,lzmaHeaders}){
 const names=['innoextract',...Object.keys(Builder.DEPENDENCIES)],directories=Object.fromEntries(names.map(name=>[name,sources[name]||path.join(root,'producers/package-support/src/external',name)]));
 fs.mkdirSync(work,{recursive:true});const headers=path.join(work,'boost-headers');fs.mkdirSync(headers);
 const archive=await buildInput(JSON.parse(fs.readFileSync(path.join(root,'producers/dependencies.json'))).boost);
 execFileSync('/usr/bin/tar',['-xf',archive,'--strip-components','1','-C',headers],{maxBuffer:Infinity,stdio:'inherit'});
 const result=await Builder.buildCandidate({directory:path.join(work,'build'),sourceDir:directories.innoextract,dependencyDirs:directories,boostHeaders:headers,architecture:arch,sdkPath,lzmaHeaders});
 return {directories,headers,result};
}
/** Add the Boost notices and seal the compiled tools. */
export async function assemble({project,version,arch,output,compiled:{directories,headers,result}}){
 addLicenses(path.dirname(path.dirname(result.executables.innoextract.path)),'Boost',headers);
 return sealRuntime({project,version,arch,output,executable:result.executables.innoextract.path,sourceRoot:directories.innoextract,upstreamRevision:Builder.REVISION,payloads:[{source:result.executables['maclauncher-inno-inspect'].path,relative:'bin/maclauncher-inno-inspect'}],runtimeFiles:{inspector:'bin/maclauncher-inno-inspect'}});
}
recipeMain(import.meta,{compile,assemble});
