import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync}from'node:child_process';import{createRequire}from'node:module';import{resolveProject,buildRecord}from'../lib/projects.mjs';import{buildInput}from'./build-input.mjs';import{helperPackage}from'./helper-package.mjs';
import {recipeMain} from './build-source.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Builder=require('../producers/included-helpers/rpgmaker-decrypter/decrypter-build.js'),Tools=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function buildDecrypter({project:id,arch,output,work}){
 const project=resolveProject(id,root,{resolvePins:false}),registered=buildRecord(project);
 fs.mkdirSync(work,{recursive:true});
 const pin=Builder.platformPin(arch),sourceArchive=await buildInput(pin.source),sdkArchive=await buildInput(pin.sdk);
 if(crypto.createHash('sha512').update(fs.readFileSync(sdkArchive)).digest('hex')!==pin.sdk.sha512)throw Error('SDK SHA-512 differs from its official release metadata.');
 const feed=path.join(work,'feed');fs.mkdirSync(feed);for(const dependency of pin.packages){const archive=await buildInput(dependency);fs.copyFileSync(archive,path.join(feed,dependency.name+'.'+dependency.version+'.nupkg'));}
 const built=Builder.buildTool({sourceArchive,sdkArchive,architecture:arch,outputDir:path.join(work,'build'),packageRoot:feed,offline:true,logPath:path.join(work,'dotnet.log')});
 const payload=path.join(output,'payload'),bin=path.join(payload,'files/bin'),licenses=path.join(payload,'files/licenses');fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(licenses,{recursive:true});
 const executable=path.join(bin,'RPGMakerDecrypter-cli');fs.copyFileSync(built.executable,executable);fs.chmodSync(executable,0o755);execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',executable],{stdio:'pipe'});execFileSync('/usr/bin/codesign',['--verify','--strict',executable],{stdio:'pipe'});
 const cpu=arch==='x64'?'x86_64':'arm64',requirements=[{path:'RPGMakerDecrypter-cli',architectures:Tools.macho(executable),minimumMacOS:Tools.loadCommands(executable,cpu).minimumMacOS}];
 const pack=pin.packages.find(row=>row.name==='microsoft.netcore.app.runtime.'+pin.runtimeIdentifier),archive=path.join(feed,pack.name+'.'+pack.version+'.nupkg'),members=execFileSync('/usr/bin/unzip',['-Z1',archive],{encoding:'utf8'}).trim().split('\n'),native=path.join(work,'native-requirements');fs.mkdirSync(native);
 for(const member of members.filter(name=>name.includes('/native/')&&!name.endsWith('/'))){const file=path.join(native,path.basename(member));fs.writeFileSync(file,execFileSync('/usr/bin/unzip',['-p',archive,member],{maxBuffer:64<<20}));const architectures=Tools.macho(file);if(!architectures)continue;if(architectures.length!==1||architectures[0]!==cpu)throw Error('Runtime pack has an unexpected native CPU: '+member);requirements.push({path:member,architectures,minimumMacOS:Tools.loadCommands(file,cpu).minimumMacOS});}
 const minimumMacOS=requirements.map(row=>row.minimumMacOS).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1),notices=[];
 for(const name of fs.readdirSync(built.publishRoot).filter(name=>/^(?:LICENSE-|DOTNET-)/.test(name))){fs.copyFileSync(path.join(built.publishRoot,name),path.join(licenses,name));fs.chmodSync(path.join(licenses,name),0o644);notices.push({name:name.replace(/\.(?:txt|md)$/i,''),license:name.includes('RPGMaker')?'MIT':name.includes('ThirdParty')?'LicenseRef-Dotnet-Third-Party':'MIT',path:'files/licenses/'+name});}
 return helperPackage({id,version:registered.version,arch,output,minimumMacOS,sourceSha256:pin.source.sha256,rosettaFiles:arch==='x64'?['files/bin/RPGMakerDecrypter-cli']:[],manifestRelative:'manifest.json',record:{managerId:id,toolABI:1,executableRelative:'files/bin/RPGMakerDecrypter-cli',source:built.record,runtimeNativeRequirements:requirements},notices});
}
recipeMain(import.meta,buildDecrypter);
