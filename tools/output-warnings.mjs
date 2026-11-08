import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Tools=require('../producers/package-support/scripts/native-binary-tools.cjs'),B=require('../sources/maclauncher/src/modules/shared/runtime/bundled-native.js');
const {excludedReason}=require('../sources/maclauncher/src/modules/shared/runtime/runtime-content.js');
const warn=message=>console.log('::warning::'+message);
process.on('uncaughtException',error=>{warn(error.message);process.exitCode=0;});
const root=path.resolve(process.argv[2]),cpu=process.argv[3],declaration=process.argv[4]?JSON.parse(fs.readFileSync(process.argv[4])):null;
const entries=fs.readdirSync(root,{recursive:true,withFileTypes:true}),files=entries.filter(entry=>entry.isFile()).map(entry=>path.join(entry.parentPath,entry.name));
const hashes=new Map(),facts=new Map(),images=new Map();
async function sha(file){const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
function signature(file){const result=spawnSync('/usr/bin/codesign',['--verify','--strict',file],{encoding:'utf8'});if(result.status!==0)warn(path.relative(root,file)+': invalid or missing code signature: '+(result.error?.message||result.stderr).trim());}
for(const file of files){
 const relative=path.relative(root,file),reason=excludedReason(relative),key=await sha(file),stat=fs.statSync(file);
 facts.set(relative,{sha256:key,size:stat.size,mode:stat.mode&0o777});
 if(reason)warn(relative+': '+reason);
 if(hashes.has(key))warn(relative+' duplicates '+hashes.get(key));else hashes.set(key,relative);
 const architectures=Tools.macho(file);
 if(!architectures)continue;
 if(!(cpu==='universal'?['arm64','x86_64']:[cpu==='x64'?'x86_64':cpu]).every(value=>architectures.includes(value)))warn(relative+': no slice for '+cpu);
 const commands=Tools.loadCommands(file);images.set(file,commands);facts.get(relative).architectures=architectures;signature(file);
 if(declaration?.minimumMacOS&&commands.minimumMacOS&&!B.versionAtLeast(declaration.minimumMacOS,commands.minimumMacOS))warn(relative+': requires macOS '+commands.minimumMacOS+' above package minimum '+declaration.minimumMacOS);
}
for(const entry of entries)if(entry.isDirectory()&&entry.name.endsWith('.app'))signature(path.join(entry.parentPath,entry.name));
for(const [file,commands]of images){
 const expand=value=>value.replace(/^@loader_path(?=\/|$)/,path.dirname(file)).replace(/^@executable_path(?=\/|$)/,path.dirname(file));
 for(const link of Tools.links(file)){
  if(link.startsWith('/usr/lib/')||link.startsWith('/System/'))continue;
  const candidates=link.startsWith('@rpath/')?commands.rpaths.map(value=>path.resolve(expand(value),link.slice(7))):[expand(link)];
  if(!candidates.some(candidate=>candidate.startsWith(root+path.sep)&&fs.existsSync(candidate)))warn(path.relative(root,file)+' links outside the stored output: '+link);
 }
}
if(declaration){
 const stored=new Set(declaration.files.map(row=>row.path));
 if(declaration.arch!==cpu)warn('Package metadata architecture '+declaration.arch+' differs from selected CPU '+cpu);
 if(process.env.BUILD_PROJECT&&process.env.BUILD_PROJECT!==declaration.id)warn('Package metadata identifies '+declaration.id+' instead of selected project '+process.env.BUILD_PROJECT);
 for(const row of declaration.files){const fact=facts.get(row.path);if(!fact||fact.sha256!==row.sha256||fact.size!==row.size||fact.mode!==row.mode||row.architectures&&row.format!=='pe'&&JSON.stringify([...row.architectures].sort())!==JSON.stringify([...(fact.architectures||[])].sort()))warn(row.path+': differs from generated package inventory');}
 for(const file of facts.keys())if(!stored.has(file))warn(file+': absent from generated package inventory');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,declaration.manifestRelative)));
 if(manifest.version!==undefined&&manifest.version!==declaration.version)warn('Built metadata version '+manifest.version+' differs from package version '+declaration.version);
 if(process.env.BUILD_VERSION&&process.env.BUILD_VERSION!==declaration.version)warn('Package version '+declaration.version+' differs from selected version '+process.env.BUILD_VERSION);
}
if(process.argv[5])for(const name of fs.readdirSync(process.argv[5]).filter(name=>name.endsWith('.tar.gz.json'))){
 const record=JSON.parse(fs.readFileSync(path.join(process.argv[5],name))),archive=path.join(process.argv[5],record.asset.filename);
 if(await sha(archive)!==record.asset.sha256||fs.statSync(archive).size!==record.asset.bytes)warn(record.asset.filename+': differs from generated release record');
 if(declaration&&record.version!==declaration.version)warn(name+': release and package versions differ');
}
