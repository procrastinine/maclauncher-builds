import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),B=require('../../lib/bundled-native.cjs');
const {validateDeclaration}=require('../../lib/declaration.cjs');
const root=import.meta.dirname;
const profiles={
 'vnds-love':{source:'vnds-love',version:'0.0.13-838e47b-MCLv1',entry:'engine/main.lua',license:'engine/LICENSE',licenseName:'MIT',minimumMacOS:'11.0'}
};
const metadata=file=>{const {bytes,...record}=B.readRegular(file,B.LIMITS.fileBytes);return record;};
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
 for(const [relative,sha256] of Object.entries(source.files)){
  B.relativeFile(relative);const input=path.join(directory,relative);
  if(metadata(input).sha256!==sha256)throw Error('The selected engine adaptation source changed: '+relative);
  if(relative.startsWith('overlays/')||relative==='engine/profile.json'||relative==='engine/bundle-profile.json')continue;
  const destination=path.join(output,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(input,destination,fs.constants.COPYFILE_EXCL);fs.chmodSync(destination,0o644);
 }
 return source;
}
function seal(project,version,arch,minimumMacOS,output,manifest,sourceSha256){
 const file=path.join(output,'manifest.json');fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');fs.chmodSync(file,0o644);
 const declaration={id:project,version,arch,launcherArchitectures:arch==='universal'?['arm64','x64']:[arch],minimumMacOS,
  sourceRelative:null,sourceSha256:sourceSha256||metadata(file).sha256,directoryRelative:[project,version,arch].join('/'),
  manifestRelative:'manifest.json',manifestSha256:metadata(file).sha256,files:inventory(output),notices:manifest.notices};
 validateDeclaration(declaration);B.verifyPayload(output,declaration);return declaration;
}
export function stageData({project,output,version=profiles[project]?.version}){
 const profile=profiles[project];if(!profile||!path.isAbsolute(output||'')||fs.existsSync(output)||!version||/[\\/]/.test(version))throw Error('Select an engine-data project and a new absolute output directory.');
 fs.mkdirSync(output,{recursive:true});
 try{
  const source=copySources(profile,output),files=inventory(output),notices=[{name:project,license:profile.licenseName,path:profile.license,sourceUrl:source.repository}];
  const manifest={schemaVersion:1,kind:'data',managerId:project,version,arch:'universal',minimumMacOS:profile.minimumMacOS,
   sourceRevision:source.revision,sourceUrl:source.repository,entryRelative:profile.entry,files,notices,loveVersion:'11.5'};
  const declaration=seal(project,version,'universal',profile.minimumMacOS,output,manifest);
  declaration.sourceRelative='manifest.json';validateDeclaration(declaration);return declaration;
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
export function main(args){const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','output','version'].includes(key)||!args[i+1])throw Error('Use --project, --output and optional --version.');options[key]=key==='output'?path.resolve(args[i+1]):args[i+1];}const declaration=stageData(options);fs.writeFileSync(options.output+'.json',JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});return {project:declaration.id,version:declaration.version,files:declaration.files.length,output:options.output};}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
