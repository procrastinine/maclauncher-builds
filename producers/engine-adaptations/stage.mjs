import {gitlink} from '../../lib/pins.mjs';
import {addLicenses} from '../../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {recipeMain} from '../../tools/build-source.mjs';
import {resolveProject,buildRecord} from '../../lib/projects.mjs';
const require=createRequire(import.meta.url),B=require('../../lib/package-format.cjs');
const {validateDeclaration}=require('../../lib/package-contract.cjs');
const root=import.meta.dirname;
const profiles={
 'vnds-love':{source:'vnds-love',version:'0.0.13-838e47b-MCLv1',entry:'engine/main.lua',minimumMacOS:'11.0'}
};
const metadata=file=>{const {bytes,...record}=B.readRegular(fs.realpathSync(file),B.LIMITS.fileBytes);return record;};
function inventory(directory,prefix=''){
 const files=[];
 for(const entry of fs.readdirSync(path.join(directory,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const relative=prefix?prefix+'/'+entry.name:entry.name;
  if(entry.isDirectory())files.push(...inventory(directory,relative));
  else if(entry.isFile())files.push({path:relative,...metadata(path.join(directory,relative))});
  else throw Error('Engine packages require regular files.');
 }
 return files;
}
function copySources(profile,output){
 const directory=path.join(root,profile.source),source=JSON.parse(fs.readFileSync(path.join(directory,'source.json')));
 for(const relative of Object.keys(source.files)){
  B.relativeFile(relative);const input=path.join(directory,relative);
  if(relative.startsWith('overlays/')||relative==='engine/profile.json'||relative==='engine/bundle-profile.json')continue;
  const destination=path.join(output,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(input,destination,fs.constants.COPYFILE_EXCL);fs.chmodSync(destination,0o644);
 }
 return source;
}
function seal(project,version,arch,minimumMacOS,output,manifest,sourceSha256){
 const file=path.join(output,'manifest.json');fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');fs.chmodSync(file,0o644);
 const declaration={id:project,version,arch,launcherArchitectures:arch==='universal'?['arm64','x64']:[arch],minimumMacOS,
  sourceRelative:null,sourceSha256:sourceSha256||metadata(file).sha256,directoryRelative:[project,version,arch].join('/'),
  manifestRelative:'manifest.json',manifestSha256:metadata(file).sha256,files:inventory(output)};
 validateDeclaration(declaration);B.verifyPayload(output,declaration);return declaration;
}
/** Copy the declared engine sources and their licenses into a new directory. */
function gather(profile,project,directory){
 const source=copySources(profile,directory);
 addLicenses(directory,project,path.join(root,profile.source,'engine'));
 return {sourceUrl:source.repository,sourceRevision:gitlink('producers/engine-adaptations/sources/VNDS-LOVE')};
}
/** Inventory gathered engine data, write its manifest and seal it. */
function describe(profile,project,version,directory,{sourceUrl,sourceRevision}){
 const files=inventory(directory);
 const manifest={schemaVersion:1,kind:'data',managerId:project,version,arch:'universal',minimumMacOS:profile.minimumMacOS,
  sourceRevision,sourceUrl,entryRelative:profile.entry,files,loveVersion:'11.5'};
 const declaration=seal(project,version,'universal',profile.minimumMacOS,directory,manifest);
 declaration.sourceRelative='manifest.json';validateDeclaration(declaration);return declaration;
}
const selected=project=>{const profile=profiles[project];if(!profile)throw Error('Select an engine-data project.');return profile;};
export function stageData({project,output,version=profiles[project]?.version}){
 const profile=profiles[project];if(!profile||!path.isAbsolute(output||'')||fs.existsSync(output)||!version||/[\\/]/.test(version))throw Error('Select an engine-data project and a new absolute output directory.');
 fs.mkdirSync(output,{recursive:true});
 try{return describe(profile,project,version,output,gather(profile,project,output));}
 catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
/** Gather the engine data. Engine data has no CPU, so it builds as universal and compiles nothing. */
export function compile({project,work}){
 const directory=path.join(work,'data');if(fs.existsSync(directory))throw Error('The engine data directory already exists.');
 fs.mkdirSync(directory,{recursive:true});return {directory,source:gather(selected(project),project,directory)};
}
/** GitHub build layout: the data package in payload/ and its declaration beside it. */
export function assemble({project,version:selectedVersion,output,compiled:{directory,source}}){
 fs.mkdirSync(output,{recursive:true});
 try{
  const version=buildRecord(resolveProject(project,path.resolve(root,'../..'),{resolvePins:false}),selectedVersion).version,payload=path.join(output,'payload');
  fs.cpSync(directory,payload,{recursive:true,errorOnExist:true,force:false});
  const declaration=describe(selected(project),project,version,payload,source);
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});return declaration;
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
recipeMain(import.meta,{compile,assemble});
