import {sourceRevision} from '../lib/pins.mjs';
import './producer-environment.mjs';
import {addLicenses,addLicense,includeLicenses} from '../lib/licenses.mjs';
import {verifyPreparedPayload} from './prepared-build-inputs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {checkoutSource,run,recipeMain} from './build-source.mjs';
import {helperPackage,sha} from './helper-package.mjs';

const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/android-inputs/blueprint');
const require=createRequire(import.meta.url),{validateDeclaration}=require('../lib/package-contract.cjs');
const read=(command,args,options={})=>execFileSync(command,args,{maxBuffer:Infinity,encoding:'utf8',...options}).trim();

/** Compile the original Blueprint parser and its existing JSON transport. */
export async function buildBlueprintInput({output,work,arch='arm64'}){
 if(!['arm64','x64'].includes(arch)||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Blueprint input builds need a package CPU and new absolute output/work directories.');
 const profile=JSON.parse(fs.readFileSync(path.join(base,'source.json')));
 fs.mkdirSync(work,{recursive:true});
 const upstream=checkoutSource({...profile.upstream,destination:path.join(work,'upstream')});
 const goPath=path.join(work,'gopath'),source=path.join(goPath,'src/github.com/google/blueprint');fs.mkdirSync(source,{recursive:true});
 fs.cpSync(path.join(upstream,'parser'),path.join(source,'parser'),{recursive:true});
 fs.mkdirSync(path.join(output,'bin'),{recursive:true});
 const parser=path.join(output,'bin/android-blueprint-parser');
 const environment={...process.env,GO111MODULE:'off',GOENV:'off',GOTOOLCHAIN:'local',GOPATH:goPath,GOCACHE:path.join(work,'go-cache'),CGO_ENABLED:'0',GOOS:'darwin',GOARCH:arch==='x64'?'amd64':'arm64'};
 run('go',['build','-p=2','-trimpath','-ldflags=-s -w -buildid=','-o',parser,path.join(base,'main.go')],{env:environment});
 return {output,upstream,parser,profile};
}

/** Describe a compiled parser: its source identity, notices and Go toolchain. */
export function describeBlueprintInput({output,upstream,parser,profile}){
 const rows=read('git',['-C',upstream,'ls-tree','-r','--format=%(objectname) %(path)','HEAD','--','parser']).split('\n').filter(Boolean).map(line=>{const split=line.indexOf(' ');return {path:line.slice(split+1),gitObject:line.slice(0,split)};}).filter(file=>file.path.endsWith('.go'));
 const identity={project:'platform/build/blueprint',repository:profile.upstream.repository,revision:sourceRevision(profile.upstream),files:rows.map(file=>({...file,sha256:sha(path.join(upstream,file.path))}))};
 const sources=path.join(output,'parser-sources.json');fs.writeFileSync(sources,JSON.stringify(identity,null,2)+'\n');
 addLicenses(output,'Blueprint',upstream);
 addLicense(output,'Go',new URL('../producers/android-inputs/licenses/go/LICENSE',import.meta.url));
 addLicense(output,'Go patents',new URL('../producers/android-inputs/licenses/go/PATENTS',import.meta.url));
 return {parser,sources,source:upstream,parserSha256:sha(parser),profile,toolchain:read('go',['version'])};
}

/** Package a compiled parser or a verified sealed input without compiling it again. */
export function packageBlueprintInput({project='android-blueprint-parser',version,arch='arm64',output,input}){
 const profile=JSON.parse(fs.readFileSync(path.join(base,'source.json')));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(input?.parser||'')||!path.isAbsolute(input?.sources||''))throw Error('Select the declared Blueprint version, compiled input and a new absolute output directory.');
 const inputRoot=path.dirname(input.sources),identity=JSON.parse(fs.readFileSync(input.sources));
 let previous;
 if(fs.existsSync(path.join(inputRoot,'input.json'))){
  const declaration=JSON.parse(fs.readFileSync(path.join(inputRoot,'../declaration.json')));validateDeclaration(declaration);
  if(declaration.id!==project||declaration.arch!==arch)throw Error('The sealed Blueprint input belongs to a different project or CPU.');
  verifyPreparedPayload(inputRoot,declaration);previous=JSON.parse(fs.readFileSync(path.join(inputRoot,declaration.manifestRelative)));
 }else{
 }
 const toolchain=input.toolchain||previous?.toolchain;
 if(typeof toolchain!=='string'||!toolchain.startsWith('go version '))throw Error('The compiled parser has no Go toolchain identity.');
 const payload=path.join(output,'payload');
 for(const relative of ['bin/android-blueprint-parser','parser-sources.json']){
  const target=path.join(payload,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(inputRoot,relative),target);
 }

 run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',path.join(payload,'bin/android-blueprint-parser')]);
 includeLicenses(payload,path.join(inputRoot,'licenses'));
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(path.join(base,'source.json')),manifestRelative:'input.json',record:{upstreamRevision:sourceRevision(profile.upstream),toolchain}});
}

/** Compile the parser for downstream Android build jobs. */
export async function compile({project,version,output,work,arch}){
 const profile=JSON.parse(fs.readFileSync(path.join(base,'source.json')));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Select the declared Blueprint input version and new absolute output/work directories.');
 return {version,compiled:await buildBlueprintInput({output:path.join(work,'compiled'),work:path.join(work,'compile'),arch})};
}
/** Package the described parser as a normal Runtime package. */
export function assemble({project,arch,output,compiled:{version,compiled}}){
 return packageBlueprintInput({project,version,arch,output,input:describeBlueprintInput(compiled)});
}
recipeMain(import.meta,{compile,assemble});
