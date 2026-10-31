import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Builder=require('../producers/maclauncher/src/modules/shared/installers/runtime/innoextract-build.js');
export async function buildInnoextract({project,version,arch,output,work,sources={},sdkPath,lzmaHeaders}){
 if(project!=='innoextract'||!['arm64','x64'].includes(arch)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Select innoextract, arm64 or x64 and a new absolute work directory.');
 const names=['innoextract',...Object.keys(Builder.DEPENDENCIES)],directories=Object.fromEntries(names.map(name=>[name,sources[name]||path.join(root,'producers/maclauncher/src/external',name)]));
 fs.mkdirSync(work,{recursive:true});const headers=path.join(work,'boost-headers');fs.mkdirSync(headers);
 const archive=await buildInput(JSON.parse(fs.readFileSync(path.join(root,'producers/maclauncher/helper-builds/innoextract.json'))).boost);
 execFileSync('/usr/bin/tar',['-xf',archive,'--strip-components','1','-C',headers],{stdio:'inherit'});
 const result=await Builder.buildCandidate({directory:path.join(work,'build'),sourceDir:directories.innoextract,dependencyDirs:directories,boostHeaders:headers,architecture:arch,sdkPath,lzmaHeaders});
 return sealRuntime({project,version,arch,output,executable:result.executables.innoextract.path,sourceRoot:directories.innoextract,upstreamRevision:Builder.REVISION,
  payloads:[{source:result.executables['maclauncher-inno-inspect'].path,relative:'bin/maclauncher-inno-inspect'}],runtimeFiles:{inspector:'bin/maclauncher-inno-inspect'},
  notices:[{file:path.join(directories.innoextract,'LICENSE'),name:'Innoextract',license:'Zlib',sourceUrl:'https://github.com/dscharrer/innoextract'},
   {file:path.join(headers,'LICENSE_1_0.txt'),name:'Boost',license:'BSL-1.0',sourceUrl:'https://github.com/boostorg/boost'}]});
}
export async function main(args){const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','version','arch','output','work'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project, --version, --arch, --output and --work.');options[key]=args[i+1];}return buildInnoextract(options);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
