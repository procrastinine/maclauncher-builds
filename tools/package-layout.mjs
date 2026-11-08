import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {dependencyResolver} from './prepared-build-inputs.mjs';
const require=createRequire(import.meta.url),B=require('../sources/maclauncher/src/modules/shared/runtime/bundled-native.js');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const readMap=env=>env.MACLAUNCHER_BUILD_INPUTS?JSON.parse(env.MACLAUNCHER_BUILD_INPUTS.trim().startsWith('{')?env.MACLAUNCHER_BUILD_INPUTS:fs.readFileSync(env.MACLAUNCHER_BUILD_INPUTS,'utf8')):{};
const relative=value=>{B.relativeFile(value);return value;};
const same=(a,b)=>a.size===b.size&&a.sha256===b.sha256;
const macho=file=>B.localMachO(file);
/** Artwork and source code remain outside stored-payload deduplication. */
export function duplicateCandidate(file,declaration){
 return file.size>0&&file.path!==declaration.manifestRelative&&file.path!==declaration.sourceRelative&&
  !/\.(?:png|jpe?g|gif|webp|ico|icns|svg|bmp|tiff?|avif|heic|ttf|otf|woff2?|eot|pyi?|md|rst|[ch]|hpp|cc|cpp)$/i.test(file.path);
}
function canonicalAlias(target,files,inputs){
 if(typeof target==='string'){relative(target);const file=files.get(target);if(!file)throw Error('Alias target is not a stored file: '+target);return {file};}
 if(!target||Object.keys(target).some(key=>!['project','path'].includes(key))||!inputs[target.project])throw Error('Alias names an undeclared prepared dependency.');
 relative(target.path);const input=inputs[target.project],file=input.declaration.files.find(file=>file.path===target.path);
 if(!file)throw Error('Dependency alias target is not a stored file.');return {file,input};
}
/** Store a freshly produced package once per content, preserving its logical paths. */
export function preparePackageLayout({input,declaration,environment=process.env}){
 const inputs=readMap(environment),aliases=Object.assign(Object.create(null),declaration.aliases?.files||{}),files=new Map(declaration.files.map(file=>[file.path,{...file}]));
 // Build inputs are not installed runtime dependencies. Restore any incoming
 // foreign aliases into this fresh payload before applying local-only dedupe.
 for(const [name,target] of Object.entries(aliases))if(typeof target!=='string'){
  relative(name);const exact=declaration.dependencies?.find(dep=>dep.project===target.project),resolved=dependencyResolver(inputs)(target,exact),actual=B.readRegular(resolved.path,resolved.size);
  if(!same(actual,resolved)||actual.mode!==resolved.mode)throw Error('Build input alias bytes differ from their sealed declaration.');
  const destination=path.join(input,name);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,actual.bytes,{flag:'wx',mode:resolved.mode});
  const {path:canonical,...facts}=resolved;files.set(name,{...facts,path:name});delete aliases[name];
 }
 // Retain the existing provider indexes; the sealed package index also describes
 // their logical paths to installers that materialize aliases before launch.
 for(const file of files.values())if(path.posix.basename(file.path)==='payload-aliases.json'){
  const value=json(path.join(input,file.path));if(value.schema!==1||!value.files)throw Error('Invalid provider payload alias index.');
  const prefix=path.posix.dirname(file.path);for(const [name,target]of Object.entries(value.files)){
   if(typeof target!=='string')throw Error('Provider aliases require local canonical targets.');
   const local=value=>relative(prefix==='.'?value:prefix+'/'+value);aliases[local(name)]=local(target);
  }
 }
 const stored=new Map(),remove=[];
 for(const file of [...files.values()].sort((a,b)=>a.path.localeCompare(b.path))){
  if(!duplicateCandidate(file,declaration))continue;
  const key=file.size+'/'+file.sha256,canonical=stored.get(key);
  if(canonical){
   aliases[file.path]=canonical.path;
   if((file.mode|canonical.mode)&0o111){canonical.mode=0o755;fs.chmodSync(path.join(input,canonical.path),canonical.mode);}
   remove.push(file.path);
  }else stored.set(key,file);
 }
 // A previously indexed provider target may itself become a package alias.
 for(const [name,target]of Object.entries(aliases)){
  let canonical=target,seen=new Set([name]);while(typeof canonical==='string'&&aliases[canonical]){if(seen.has(canonical))throw Error('Payload aliases form a cycle.');seen.add(canonical);canonical=aliases[canonical];}aliases[name]=canonical;
 }
 for(const name of remove){fs.unlinkSync(path.join(input,name));files.delete(name);}
 for(const [name,target]of Object.entries(aliases)){relative(name);if(files.has(name))throw Error('Payload alias overlaps a stored file.');canonicalAlias(target,files,inputs);}
 declaration.files=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
 if(Object.keys(aliases).length)declaration.aliases={schema:1,files:aliases};else delete declaration.aliases;
 delete declaration.dependencies;
 return declaration;
}
/** Restore logical paths only after their canonical inventories are recorded. */
export function materializePackageAliases({root,declaration,inputs}){
 const files=new Map(declaration.files.map(file=>[file.path,file]));
 for(const [name,target]of Object.entries(declaration.aliases?.files||{})){
  relative(name);const resolved=canonicalAlias(target,files,inputs),source=typeof target==='string'?path.join(root,target):path.join(resolved.input.root,target.path),destination=path.join(root,name);
  const actual=B.readRegular(source,resolved.file.size);if(!same(actual,resolved.file))throw Error('Alias canonical bytes changed.');
  fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination)||fs.lstatSync(destination,{throwIfNoEntry:false}))throw Error('Alias output already exists.');
  if(typeof target==='string'&&!macho(resolved.file))fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
  else fs.symlinkSync(path.relative(path.dirname(destination),source),destination);
 }
 return root;
}
