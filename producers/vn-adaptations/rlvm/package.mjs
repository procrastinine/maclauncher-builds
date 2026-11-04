import {addLicenses} from '../../../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {recipeMain} from '../../../tools/build-source.mjs';
import {pack} from '../../../tools/runtime-package.mjs';
import {resolveProject,buildRecord} from '../../../lib/projects.mjs';
const require=createRequire(import.meta.url),B=require('../../../lib/bundled-native.cjs');
const M=require('../../maclauncher/src/modules/shared/runtime/macho-load-commands.js');
const here=import.meta.dirname,root=path.resolve(here,'../../..'),sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function packageAdapter({output,binary,archive:packed=true,version}){
 const sourceFile=path.join(here,'source.json'),source=JSON.parse(fs.readFileSync(sourceFile));
 const project=resolveProject(source.id,root,{resolvePins:false});version??=buildRecord(project).version;
 if(!project.packageProfiles.some(row=>row.version===version))throw Error('Select a declared RLVM package version.');

 const profile=JSON.parse(fs.readFileSync(path.join(here,'adapter.json')));
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||source.id!=='rlvm-adapter'||source.adapterABI!==1)throw Error('Choose a new absolute adapter output directory.');
 for(const [relative,expected] of Object.entries(source.files)){B.relativeFile(relative);const file=path.resolve(here,relative);if(!file.startsWith(here+path.sep)||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||sha(file)!==expected)throw Error('The adapter producer input changed: '+relative);}
 if(!path.isAbsolute(binary||''))throw Error('Packaging requires an explicit compiled adapter from the source build.');
 if(sha(path.join(here,'adapter.m'))!==profile.sourceSha256)throw Error('The adapter binary and owned source identities differ from their profile.');
 const image=M.assertSystemLibraryClosure(M.readMachOLoadCommands(binary),{fileType:6,installName:'@rpath/rlvm-adapter.dylib',maximumMacOS:source.minimumMacOS});
 if(JSON.stringify([...image.architectures].sort())!==JSON.stringify(['arm64','x86_64']))throw Error('The adapter requires both Mac CPU architectures.');
 execFileSync('/usr/bin/codesign',['--verify','--strict',binary],{stdio:'pipe',timeout:30000});
 const payload=path.join(output,'payload'),files=path.join(payload,'files');fs.mkdirSync(files,{recursive:true});
 try{
  for(const [input,name] of [[binary,'rlvm-adapter.dylib'],[path.join(here,'adapter.json'),'adapter.json']]){fs.copyFileSync(input,path.join(files,name),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(files,name),name.endsWith('.dylib')?0o755:0o644);}
  addLicenses(files,'MacLauncher',root);
  fs.writeFileSync(path.join(files,'adapter.json'),JSON.stringify({...profile,sha256:sha(binary)},null,2)+'\n');
  const inventory=B.fileInventory(files).map(name=>{const {bytes,...stored}=B.readRegular(path.join(files,name),B.LIMITS.fileBytes);return {path:name,...stored,...(name.endsWith('.dylib')?{architectures:['arm64','x86_64']}:{})};});
  const manifest={schemaVersion:1,managerId:source.id,version,arch:'universal',minimumMacOS:source.minimumMacOS,adapterABI:1,executableRelative:'rlvm-adapter.dylib',files:inventory,sourceSha256:sha(sourceFile),dependencies:[{file:'rlvm-adapter.dylib',links:[...new Set(image.slices.flatMap(slice=>slice.dependencies.map(row=>row.path)))]}]};
  const manifestFile=path.join(payload,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
  const {bytes,...stored}=B.readRegular(manifestFile,B.LIMITS.manifestBytes);
  const declaration={id:source.id,version,arch:'universal',launcherArchitectures:['arm64','x64'],minimumMacOS:source.minimumMacOS,sourceRelative:null,sourceSha256:sha(sourceFile),manifestRelative:'manifest.json',manifestSha256:stored.sha256,directoryRelative:[source.id,version,'universal'].join('/'),files:[...inventory.map(row=>({...row,path:'files/'+row.path})),{path:'manifest.json',...stored}]};
  B.verifyPayload(payload,declaration);fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
  if(!packed)return {declaration};
  const archive=path.join(output,source.id+'-'+version+'-universal.tar.gz');
  return {archive,record:await pack({project:source.id,input:payload,declaration,output:archive})};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
/** GitHub build: compile the owned source with its recorded universal arguments, then package it. */
export async function build({output,work,version}){
 const profile=JSON.parse(fs.readFileSync(path.join(here,'adapter.json')));
 fs.mkdirSync(work,{recursive:true});fs.copyFileSync(path.join(here,'adapter.m'),path.join(work,'adapter.m'));
 execFileSync(profile.build.command,profile.build.args,{cwd:work,stdio:'inherit',timeout:120000});
 if(profile.signature!=='ad-hoc')throw Error('The adapter profile selects an unsupported signature.');
 execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',path.join(work,profile.path)],{stdio:'pipe',timeout:30000});
 return packageAdapter({output,binary:path.join(work,profile.path),archive:false,version});
}
recipeMain(import.meta,build);
