import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {dependencyResolver} from './prepared-build-inputs.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),Tools=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const readMap=env=>env.MACLAUNCHER_BUILD_INPUTS?JSON.parse(env.MACLAUNCHER_BUILD_INPUTS.trim().startsWith('{')?env.MACLAUNCHER_BUILD_INPUTS:fs.readFileSync(env.MACLAUNCHER_BUILD_INPUTS,'utf8')):{};
const relative=value=>{B.relativeFile(value);return value;};
const same=(a,b)=>a.size===b.size&&a.sha256===b.sha256;
const macho=file=>B.localMachO(file);
/** Notices, artwork and source texts are outside the binary duplication rule. */
export function duplicateCandidate(file,declaration){
 return file.size>0&&file.path!==declaration.manifestRelative&&file.path!==declaration.sourceRelative&&
  !(Array.isArray(declaration.notices)?declaration.notices:[]).some(notice=>notice?.path===file.path)&&
  !/(?:^|\/)(?:licenses?|notices?|copyright|copying)(?:[./_-]|$)/i.test(file.path)&&
  !/\.(?:png|jpe?g|gif|webp|ico|icns|svg|bmp|tiff?|avif|heic|ttf|otf|woff2?|eot|pyi?|md|rst|txt|[ch]|hpp|cc|cpp)$/i.test(file.path);
}
function canonicalAlias(target,files,inputs){
 if(typeof target==='string'){relative(target);const file=files.get(target);if(!file)throw Error('Alias target is not a stored file: '+target);return {file};}
 if(!target||Object.keys(target).some(key=>!['project','path'].includes(key))||!inputs[target.project])throw Error('Alias names an undeclared prepared dependency.');
 relative(target.path);const input=inputs[target.project],file=input.declaration.files.find(file=>file.path===target.path);
 if(!file)throw Error('Dependency alias target is not a stored file.');return {file,input};
}
/** A native alias must retain the same loader bindings at its logical location. */
function checkNativeAliasPaths({root,declaration,inputs}){
 const files=new Map(declaration.files.map(file=>[file.path,file])),aliases=Object.entries(declaration.aliases?.files||{});
 // Use the installer's exact bounded-reader rule for local aliases. Foreign
 // imports also retain their existing complete dependency-closure check below.
 for(const [name,target]of aliases)if(typeof target==='string')B.validateLocalAlias(root,name,target,declaration,dependencyResolver(inputs));
 const native=aliases.flatMap(([name,target])=>{const resolved=canonicalAlias(target,files,inputs);if(!macho(resolved.file))return [];return [{name,target,facts:resolved.file,canonical:typeof target==='string'?path.join(root,target):path.join(resolved.input.root,target.path)}];});
 const cross=native.filter(({name,target,canonical})=>typeof target!=='string'&&path.dirname(path.join(root,name))!==path.dirname(canonical));
 if(!cross.length)return;
 const created=[];
 try{
  // Only native aliases are needed for resolving load commands. These temporary
  // links never enter the regular-file archive or change a stored canonical file.
  for(const {name,canonical}of native){
   const alias=path.join(root,name);
   if(!fs.lstatSync(alias,{throwIfNoEntry:false})){fs.mkdirSync(path.dirname(alias),{recursive:true});fs.symlinkSync(path.relative(path.dirname(alias),canonical),alias);created.push(alias);}
  }
  const inspected=new Map();
  for(const {name,canonical,facts}of cross){
   const alias=path.join(root,name);
   for(const cpu of facts.architectures){
    const key=canonical+'\0'+cpu;if(!inspected.has(key))inspected.set(key,{commands:Tools.loadCommands(canonical,cpu),ids:Tools.libraryIds(canonical,cpu),links:Tools.links(canonical,cpu)});
    const {commands,ids,links}=inspected.get(key);
    for(const link of links){
     if(ids.includes(link)||!link.startsWith('@loader_path/')&&!(link.startsWith('@rpath/')&&commands.rpaths.some(value=>value.includes('@loader_path'))))continue;
     let left,right;
     try{left=Tools.resolveLink(link,canonical,canonical,commands.rpaths,cpu);right=Tools.resolveLink(link,alias,canonical,commands.rpaths,cpu);}catch{throw Error('Cross-directory Mach-O alias has an unresolved load command: '+name+' ('+link+').');}
     if(left!==right)throw Error('Cross-directory Mach-O alias changes its load-command target: '+name+' ('+link+').');
    }
   }
  }
 }finally{for(const alias of created.reverse())fs.unlinkSync(alias);}
}
/** Store a freshly produced package once per content, preserving its logical paths. */
export function preparePackageLayout({input,declaration,environment=process.env}){
 const inputs=readMap(environment),aliases=Object.assign(Object.create(null),declaration.aliases?.files||{}),files=new Map(declaration.files.map(file=>[file.path,{...file}]));
 B.verifyStoredPayload(input,declaration);
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
 checkNativeAliasPaths({root:input,declaration,inputs});
 return declaration;
}
/** The single stored-content check used by Build and release. */
export function checkPackageDuplicates({declaration,environment=process.env}){
 const files=new Map();if(declaration.dependencies?.length)throw Error('Runtime packages must be self-contained.');
 for(const file of declaration.files){if(!duplicateCandidate(file,declaration))continue;const key=file.size+'/'+file.sha256;if(files.has(key))throw Error('Duplicate stored payload bytes: '+file.path+' = '+files.get(key));files.set(key,file.path);}
 return {storedFiles:declaration.files.length,aliases:Object.keys(declaration.aliases?.files||{}).length,dependencies:0};
}
/** Restore logical paths only after their canonical inventories are verified. */
export function materializePackageAliases({root,declaration,inputs}){
 const files=new Map(declaration.files.map(file=>[file.path,file]));
 for(const [name,target]of Object.entries(declaration.aliases?.files||{})){
  relative(name);const resolved=canonicalAlias(target,files,inputs),source=typeof target==='string'?path.join(root,target):path.join(resolved.input.root,target.path),destination=path.join(root,name);
  const actual=B.readRegular(source,resolved.file.size);if(!same(actual,resolved.file))throw Error('Alias canonical bytes changed.');
  fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination)||fs.lstatSync(destination,{throwIfNoEntry:false}))throw Error('Alias output already exists.');
  if(typeof target==='string'&&!macho(resolved.file))fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
  else fs.symlinkSync(path.relative(path.dirname(destination),source),destination);
 }
 checkNativeAliasPaths({root,declaration,inputs});
 B.verifyPayload(root,declaration,dependencyResolver(inputs));
 return root;
}
