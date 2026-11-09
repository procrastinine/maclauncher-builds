import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {sourceRevision,sourceCheckout} from '../lib/pins.mjs';
const root=path.resolve(import.meta.dirname,'..');
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:Infinity}).trim();
/** Recipe JSON names an app file as "app:<path inside the app repository>". */
export const APP_REFERENCE='app:';
const verified=new Map();
/** The app is the source authority; Builds reads its exact clean pin in place.
 * The pin is the gitlink that producers/package-support/app-source.json names. */
export function appSourceRoot(repository=root){
 if(verified.has(repository))return verified.get(repository);
 const profile=JSON.parse(fs.readFileSync(path.join(repository,'producers/package-support/app-source.json')));
 const directory=path.join(repository,sourceCheckout(profile)),revision=sourceRevision(profile,repository);
 if(!fs.existsSync(path.join(directory,'.git'))||git(directory,['rev-parse','HEAD'])!==revision)throw Error('Initialize the exact declared MacLauncher app source pin.');
 if(git(directory,['status','--porcelain','--untracked-files=no','--ignore-submodules=all']))throw Error('The pinned app source has tracked changes.');
 const origin=git(directory,['remote','get-url','origin']).replace(/^git@github.com:/,'https://github.com/').replace(/\.git$/,'').replace(/\/$/,'');
 if(origin!==profile.repository)throw Error('The app source origin differs from its public declaration.');
 const result=Object.freeze({directory,revision});
 verified.set(repository,result);
 return result;
}
/** An owned build input is a regular file, or a link whose real path is a
 * regular file inside this checkout, which holds the pinned app source and its
 * submodules. Staged copies outside the checkout are regular files. */
export function isOwnedFile(file){
 let stat;try{stat=fs.lstatSync(file);}catch{return false;}
 if(!stat.isSymbolicLink())return stat.isFile();
 let real;try{real=fs.realpathSync(file);}catch{return false;}
 return real.startsWith(root+path.sep)&&fs.statSync(real).isFile();
}
/** The absolute path of a file or directory inside the verified app checkout. */
export function appPath(relative){
 if(typeof relative!=='string'||!relative||relative.startsWith('/')||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Name an app file by its normalized path inside the app repository: '+relative);
 return path.join(appSourceRoot().directory,...relative.split('/'));
}
/** Load an app module in place, so its own relative imports resolve inside the app. */
export function appRequire(relative){return createRequire(path.join(appSourceRoot().directory,'package.json'))(appPath(relative));}
/** The tracked files below an app directory at the pin, relative to that directory. */
export function appFiles(relative){
 const directory=appPath(relative),prefix=path.relative(appSourceRoot().directory,directory).split(path.sep).join('/')+'/';
 return git(appSourceRoot().directory,['ls-files','-z','--',prefix]).split('\0').filter(Boolean).map(file=>file.slice(prefix.length));
}
const producerModules=path.join(root,'producers/package-support');
/** A file of a module directory that Builds and the app share by layout:
 * Builds' own file at producers/package-support/<relative> when it has one,
 * otherwise the app file at <relative>. Builds keeps a module's production
 * recipes and records; the app keeps its runtime code and the native sources
 * that packages compile. */
export function moduleFile(relative){
 const normalized=typeof relative==='string'?path.posix.normalize(relative):'';
 if(!normalized||normalized.startsWith('../')||normalized==='..'||normalized.startsWith('/'))throw Error('Name a module file by its normalized repository path: '+relative);
 const owned=path.join(producerModules,...normalized.split('/'));
 return fs.statSync(owned,{throwIfNoEntry:false})?.isFile()?owned:appPath(normalized);
}
/** The files below a module directory, relative to it: Builds' own files and
 * the app's tracked files, each name once. moduleFile resolves each name. */
export function moduleFiles(relative){
 const directory=path.join(producerModules,...relative.split('/'));
 const owned=fs.existsSync(directory)?fs.readdirSync(directory,{recursive:true}).filter(name=>fs.statSync(path.join(directory,name)).isFile()).map(name=>name.split(path.sep).join('/')):[];
 const app=fs.existsSync(appPath(relative))?appFiles(relative):[];
 return [...new Set([...owned,...app])].sort();
}
/** Write the bytes of one app file into a build work tree that needs it beside
 * other sources. Work trees are never payloads. */
export function exportAppFile(relative,destination){
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 fs.copyFileSync(appPath(relative),destination);
 return destination;
}
/** Write a complete module directory into a build work tree for a tool that
 * needs one self-contained source tree: each name from moduleFiles, resolved
 * by moduleFile. Work trees are never payloads. */
export function exportModuleTree(relative,destination,include=()=>true){
 for(const name of moduleFiles(relative).filter(include)){
  const target=path.join(destination,...name.split('/'));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(moduleFile(relative+'/'+name),target);
 }
 return destination;
}
/** Resolve a recipe path: "app:<path>" names an app file, anything else is relative to base. */
export function recipePath(base,value){
 if(typeof value!=='string'||!value)throw Error('A recipe path is required.');
 return value.startsWith(APP_REFERENCE)?appPath(value.slice(APP_REFERENCE.length)):path.resolve(base,value);
}
