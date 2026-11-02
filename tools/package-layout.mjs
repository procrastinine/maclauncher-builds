import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {dependencyResolver} from './prepared-build-inputs.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const readMap=env=>env.MACLAUNCHER_BUILD_INPUTS?JSON.parse(env.MACLAUNCHER_BUILD_INPUTS.trim().startsWith('{')?env.MACLAUNCHER_BUILD_INPUTS:fs.readFileSync(env.MACLAUNCHER_BUILD_INPUTS,'utf8')):{};
const relative=value=>{B.relativeFile(value);return value;};
const same=(a,b)=>a.size===b.size&&a.sha256===b.sha256;
/** Notices, artwork and source texts are outside the binary duplication rule. */
export function duplicateCandidate(file,declaration){
 return file.size>0&&file.path!==declaration.manifestRelative&&file.path!==declaration.sourceRelative&&
  !declaration.notices.some(notice=>notice.path===file.path)&&
  !/(?:^|\/)(?:licenses?|notices?|copyright|copying)(?:[./_-]|$)/i.test(file.path)&&
  !/\.(?:png|jpe?g|gif|webp|ico|icns|svg|bmp|tiff?|avif|heic|ttf|otf|woff2?|eot|pyi?|md|rst|txt|[ch]|hpp|cc|cpp)$/i.test(file.path);
}
function canonicalAlias(target,files,inputs){
 if(typeof target==='string'){relative(target);const file=files.get(target);if(!file)throw Error('Alias target is not a stored file: '+target);return {file};}
 if(!target||Object.keys(target).some(key=>!['project','path'].includes(key))||!inputs[target.project])throw Error('Alias names an undeclared prepared dependency.');
 relative(target.path);const input=inputs[target.project],file=input.declaration.files.find(file=>file.path===target.path);
 if(!file)throw Error('Dependency alias target is not a stored file.');return {file,input};
}
/** Store a freshly produced package once per content, preserving its logical paths. */
export function preparePackageLayout({input,declaration,environment=process.env}){
 const inputs=readMap(environment),aliases=Object.assign(Object.create(null),declaration.aliases?.files||{}),files=new Map(declaration.files.map(file=>[file.path,{...file}])),dependencies=new Map((declaration.dependencies||[]).map(dep=>[dep.project,dep]));
 B.verifyStoredPayload(input,declaration);
 const shared=new Map();
 for(const [project,dep]of Object.entries(inputs))for(const file of dep.declaration.files){
  if(!duplicateCandidate(file,dep.declaration))continue;
  const key=file.size+'/'+file.sha256;if(!shared.has(key))shared.set(key,{project,path:file.path,input:dep,file});
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
  const key=file.size+'/'+file.sha256,dependency=shared.get(key),canonical=stored.get(key);
  if(dependency){
   aliases[file.path]={project:dependency.project,path:dependency.path};
   const record=dependency.input.record;dependencies.set(dependency.project,{project:dependency.project,release:record.version,sha256:record.asset.sha256});remove.push(file.path);
  }else if(canonical){
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
 for(const [name,target]of Object.entries(aliases)){relative(name);if(files.has(name))throw Error('Payload alias overlaps a stored file.');const resolved=canonicalAlias(target,files,inputs);if(typeof target!=='string'){const record=resolved.input.record;dependencies.set(target.project,{project:target.project,release:record.version,sha256:record.asset.sha256});}}
 declaration.files=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
 if(Object.keys(aliases).length)declaration.aliases={schema:1,files:aliases};
 if(dependencies.size)declaration.dependencies=[...dependencies.values()].sort((a,b)=>a.project.localeCompare(b.project));
 return declaration;
}
/** The single stored-content check used by Build and release. */
export function checkPackageDuplicates({declaration,environment=process.env}){
 const files=new Map(),inputs=readMap(environment),dependencies=new Set((declaration.dependencies||[]).map(dep=>dep.project));
 for(const id of dependencies){const input=inputs[id];if(!input)throw Error('Duplicate check needs the exact verified dependency: '+id);for(const file of input.declaration.files)if(duplicateCandidate(file,input.declaration))files.set(file.size+'/'+file.sha256,id+'/'+file.path);}
 for(const file of declaration.files){if(!duplicateCandidate(file,declaration))continue;const key=file.size+'/'+file.sha256;if(files.has(key))throw Error('Duplicate stored payload bytes: '+file.path+' = '+files.get(key));files.set(key,file.path);}
 return {storedFiles:declaration.files.length,aliases:Object.keys(declaration.aliases?.files||{}).length,dependencies:dependencies.size};
}
/** Restore logical paths only after their canonical inventories are verified. */
export function materializePackageAliases({root,declaration,inputs}){
 const files=new Map(declaration.files.map(file=>[file.path,file]));
 for(const [name,target]of Object.entries(declaration.aliases?.files||{})){
  relative(name);const resolved=canonicalAlias(target,files,inputs),source=typeof target==='string'?path.join(root,target):path.join(resolved.input.root,target.path),destination=path.join(root,name);
  const actual=B.readRegular(source,resolved.file.size);if(!same(actual,resolved.file))throw Error('Alias canonical bytes changed.');
  fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination)||fs.lstatSync(destination,{throwIfNoEntry:false}))throw Error('Alias output already exists.');
  if(typeof target==='string')fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
  else fs.symlinkSync(path.relative(path.dirname(destination),source),destination);
 }
 B.verifyPayload(root,declaration,dependencyResolver(inputs));
 return root;
}
