import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack} from '../../../tools/runtime-package.mjs';
const require=createRequire(import.meta.url),B=require('../../../lib/bundled-native.cjs');
const M=require('../../maclauncher/src/modules/shared/runtime/macho-load-commands.js');
const here=import.meta.dirname,sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function packageAdapter({output,binary,archive:packed=true}){
 const sourceFile=path.join(here,'source.json'),source=JSON.parse(fs.readFileSync(sourceFile));
 if(sha(path.join(here,'..','LICENSE'))!==source.licenseSha256)throw Error('The adapter license identity changed.');
 const profile=JSON.parse(fs.readFileSync(path.join(here,'adapter.json')));
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||source.id!=='rlvm-adapter'||source.adapterABI!==1)throw Error('Choose a new absolute adapter output directory.');
 for(const [relative,expected] of Object.entries(source.files)){B.relativeFile(relative);const file=path.resolve(here,relative);if(!file.startsWith(here+path.sep)||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||sha(file)!==expected)throw Error('The adapter producer input changed: '+relative);}
 // The committed binary must match its profile; a GitHub build compiles the same owned source.
 if(sha(path.join(here,'adapter.m'))!==profile.sourceSha256||binary===undefined&&sha(path.join(here,'prebuilt',profile.path))!==profile.sha256)throw Error('The adapter binary and owned source identities differ from their profile.');
 binary??=path.join(here,'prebuilt',profile.path);const image=M.assertSystemLibraryClosure(M.readMachOLoadCommands(binary),{fileType:6,installName:'@rpath/rlvm-adapter.dylib',maximumMacOS:source.minimumMacOS});
 if(JSON.stringify([...image.architectures].sort())!==JSON.stringify(['arm64','x86_64']))throw Error('The adapter requires both Mac CPU architectures.');
 execFileSync('/usr/bin/codesign',['--verify','--strict',binary],{stdio:'pipe',timeout:30000});
 const payload=path.join(output,'payload'),files=path.join(payload,'files');fs.mkdirSync(files,{recursive:true});
 try{
  for(const [input,name] of [[binary,'rlvm-adapter.dylib'],[path.join(here,'adapter.json'),'adapter.json'],[path.join(here,'..','LICENSE'),'LICENSE']]){fs.copyFileSync(input,path.join(files,name),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(files,name),name.endsWith('.dylib')?0o755:0o644);}
  const inventory=B.fileInventory(files).map(name=>{const {bytes,...stored}=B.readRegular(path.join(files,name),B.LIMITS.fileBytes);return {path:name,...stored,...(name.endsWith('.dylib')?{architectures:['arm64','x86_64']}:{})};});
  const notices=[{name:'MacLauncher RLVM adapter',license:'MIT',sourceUrl:source.repository,path:'LICENSE'}];
  const manifest={schemaVersion:1,managerId:source.id,version:source.version,arch:'universal',minimumMacOS:source.minimumMacOS,adapterABI:1,executableRelative:'rlvm-adapter.dylib',files:inventory,notices,sourceSha256:sha(sourceFile),dependencies:[{file:'rlvm-adapter.dylib',links:[...new Set(image.slices.flatMap(slice=>slice.dependencies.map(row=>row.path)))]}]};
  const manifestFile=path.join(payload,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
  const {bytes,...stored}=B.readRegular(manifestFile,B.LIMITS.manifestBytes);
  const declaration={id:source.id,version:source.version,arch:'universal',launcherArchitectures:['arm64','x64'],minimumMacOS:source.minimumMacOS,sourceRelative:null,sourceSha256:sha(sourceFile),manifestRelative:'manifest.json',manifestSha256:stored.sha256,directoryRelative:[source.id,source.version,'universal'].join('/'),files:[...inventory.map(row=>({...row,path:'files/'+row.path})),{path:'manifest.json',...stored}],notices:notices.map(row=>({...row,path:'files/'+row.path}))};
  B.verifyPayload(payload,declaration);fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
  if(!packed)return {declaration};
  const archive=path.join(output,source.id+'-'+source.version+'-universal.tar.gz');
  return {archive,record:await pack({project:source.id,input:payload,declaration,output:archive})};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
/** GitHub build: compile the owned source with its recorded universal arguments, then package it. */
export async function build({project,arch,output,work}){
 const profile=JSON.parse(fs.readFileSync(path.join(here,'adapter.json')));
 if(project!=='rlvm-adapter'||arch!=='universal'||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('The RLVM adapter builds as a universal package with a new absolute work directory.');
 fs.mkdirSync(work,{recursive:true});fs.copyFileSync(path.join(here,'adapter.m'),path.join(work,'adapter.m'));
 execFileSync(profile.build.command,profile.build.args,{cwd:work,stdio:'inherit',timeout:120000});
 if(profile.signature!=='ad-hoc')throw Error('The adapter profile selects an unsupported signature.');
 execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',path.join(work,profile.path)],{stdio:'pipe',timeout:30000});
 return packageAdapter({output,binary:path.join(work,profile.path),archive:false});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['output','project','arch','work'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --output with a new absolute directory, or --project, --arch, --output and --work.');options[key]=args[i+1];}
 (options.arch?build(options):Object.keys(options).join()==='output'?packageAdapter(options):Promise.reject(Error('Use --output with a new absolute directory.'))).then(result=>console.log(JSON.stringify(result.archive?result:{id:result.declaration.id,version:result.declaration.version,arch:result.declaration.arch}))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
