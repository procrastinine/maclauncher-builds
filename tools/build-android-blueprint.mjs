import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {checkoutSource,run,recipeMain} from './build-source.mjs';
import {helperPackage,sha} from './helper-package.mjs';

const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/android-inputs/blueprint');
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',...options}).trim();

/** Compile the original Blueprint parser and its existing JSON transport. */
export async function buildBlueprintInput({output,work,arch='arm64'}){
 if(!['arm64','x64'].includes(arch)||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Blueprint input builds need a package CPU and new absolute output/work directories.');
 const profile=JSON.parse(fs.readFileSync(path.join(base,'source.json')));
 if(sha(path.join(base,'main.go'))!==profile.driverSha256)throw Error('Blueprint JSON transport differs from its source identity.');
 fs.mkdirSync(work,{recursive:true});
 const upstream=checkoutSource({...profile.upstream,destination:path.join(work,'upstream')});
 const goPath=path.join(work,'gopath'),source=path.join(goPath,'src/github.com/google/blueprint');fs.mkdirSync(source,{recursive:true});
 fs.cpSync(path.join(upstream,'parser'),path.join(source,'parser'),{recursive:true});
 fs.mkdirSync(path.join(output,'bin'),{recursive:true});
 const parser=path.join(output,'bin/android-blueprint-parser');
 const environment={...process.env,GO111MODULE:'off',GOENV:'off',GOTOOLCHAIN:'local',GOPATH:goPath,GOCACHE:path.join(work,'go-cache'),CGO_ENABLED:'0',GOOS:'darwin',GOARCH:arch==='x64'?'amd64':'arm64'};
 run('go',['build','-p=2','-trimpath','-ldflags=-s -w -buildid=','-o',parser,path.join(base,'main.go')],{env:environment});
 const rows=read('git',['-C',upstream,'ls-tree','-r','--format=%(objectname) %(path)','HEAD','--','LICENSE','parser']).split('\n').filter(Boolean).map(line=>{const split=line.indexOf(' ');return {path:line.slice(split+1),gitObject:line.slice(0,split)};}).filter(file=>file.path==='LICENSE'||file.path.endsWith('.go'));
 const identity={project:'platform/build/blueprint',repository:profile.upstream.repository,revision:profile.upstream.revision,files:rows.map(file=>({...file,sha256:sha(path.join(upstream,file.path))})),driverSha256:profile.driverSha256};
 const sources=path.join(output,'parser-sources.json');fs.writeFileSync(sources,JSON.stringify(identity,null,2)+'\n');
 fs.mkdirSync(path.join(output,'notices'),{recursive:true});fs.copyFileSync(path.join(upstream,'LICENSE'),path.join(output,'notices/blueprint-LICENSE'));
 const goRoot=read('go',['env','GOROOT']),goPrefix=read('brew',['--prefix','go']);
 const license=[path.join(goRoot,'LICENSE'),path.join(goPrefix,'LICENSE')].find(file=>fs.existsSync(file));
 if(!license)throw Error('The Go runtime license is missing.');
 fs.copyFileSync(license,path.join(output,'notices/go-LICENSE'));
 fs.copyFileSync(path.join(goRoot,'PATENTS'),path.join(output,'notices/go-PATENTS'));
 return {parser,sources,source:upstream,parserSha256:sha(parser),profile,toolchain:read('go',['version'])};
}

/** Package a compiled parser or a verified sealed input without compiling it again. */
export function packageBlueprintInput({project='android-blueprint-parser',version,arch='arm64',output,input}){
 const profile=JSON.parse(fs.readFileSync(path.join(base,'source.json')));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(input?.parser||'')||!path.isAbsolute(input?.sources||''))throw Error('Select the declared Blueprint version, compiled input and a new absolute output directory.');
 const inputRoot=path.dirname(input.sources),identity=JSON.parse(fs.readFileSync(input.sources));
 if(path.dirname(path.dirname(input.parser))!==inputRoot||identity.revision!==profile.upstream.revision||identity.repository!==profile.upstream.repository||identity.driverSha256!==profile.driverSha256)throw Error('The compiled parser source identity differs from this package profile.');
 let previous;
 if(fs.existsSync(path.join(inputRoot,'input.json'))){
  const declaration=JSON.parse(fs.readFileSync(path.join(inputRoot,'../declaration.json')));validateDeclaration(declaration);
  if(declaration.id!==project||declaration.arch!==arch)throw Error('The sealed Blueprint input belongs to a different project or CPU.');
  B.verifyPayload(inputRoot,declaration);previous=JSON.parse(fs.readFileSync(path.join(inputRoot,declaration.manifestRelative)));
 }else{
  if(!path.isAbsolute(input.source||'')||read('git',['-C',input.source,'rev-parse','HEAD'])!==profile.upstream.revision||read('git',['-C',input.source,'status','--porcelain','--untracked-files=no'])||sha(input.parser)!==input.parserSha256)throw Error('The Blueprint compiler output differs from its declared source build.');
 }
 const toolchain=input.toolchain||previous?.toolchain;
 if(typeof toolchain!=='string'||!toolchain.startsWith('go version '))throw Error('The compiled parser has no Go toolchain identity.');
 const payload=path.join(output,'payload');
 for(const relative of ['bin/android-blueprint-parser','parser-sources.json','notices/blueprint-LICENSE','notices/go-LICENSE','notices/go-PATENTS']){
  const target=path.join(payload,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(inputRoot,relative),target);
 }
 run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',path.join(payload,'bin/android-blueprint-parser')]);
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(path.join(base,'source.json')),manifestRelative:'input.json',record:{upstreamRevision:profile.upstream.revision,toolchain},notices:[{name:'Android Blueprint parser',license:'Apache-2.0',path:'notices/blueprint-LICENSE',sourceUrl:profile.upstream.repository},{name:'Go runtime',license:'BSD-3-Clause',path:'notices/go-LICENSE',sourceUrl:'https://go.googlesource.com/go'},{name:'Go runtime patent grant',license:'Go patent grant',path:'notices/go-PATENTS',sourceUrl:'https://go.googlesource.com/go'}]});
}

/** Produce a normal Runtime package for downstream Android build jobs. */
export async function buildAndroidBlueprint({project,version,arch,output,work}){
 const profile=JSON.parse(fs.readFileSync(path.join(base,'source.json')));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Select the declared Blueprint input version and new absolute output/work directories.');
 const input=await buildBlueprintInput({output:path.join(work,'compiled'),work:path.join(work,'compile'),arch});
 return packageBlueprintInput({project,version,arch,output,input});
}
recipeMain(import.meta,buildAndroidBlueprint);
