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
/** The tracked symlinks of a checkout that point into one of its own gitlinks, among entries
 * (files, or directories naming every file below; every symlink when omitted). A reader of such a
 * symlink reads that gitlink's file at the commit the checkout records. */
export function checkoutGitlinkFiles(directory,entries){
 const stage=git(directory,['ls-files','-s','-z']).split('\0').filter(Boolean).map(line=>{const match=/^(\d+) ([a-f0-9]{40}) \d\t(.+)$/s.exec(line);return {mode:match[1],object:match[2],path:match[3]};});
 const links=stage.filter(row=>row.mode==='160000'),declared=entries?.map(entry=>entry.replace(/\/$/,''));
 const symlinks=stage.filter(row=>row.mode==='120000'&&(!declared||declared.some(entry=>row.path===entry||row.path.startsWith(entry+'/'))));
 if(!symlinks.length||!links.length)return [];
 const output=execFileSync('git',['-C',directory,'cat-file','--batch'],{input:symlinks.map(row=>row.object).join('\n')+'\n',encoding:'utf8',maxBuffer:Infinity}),targets=[];
 for(let offset=0;offset<output.length;){const end=output.indexOf('\n',offset),size=Number(output.slice(offset,end).split(' ')[2]);targets.push(output.slice(end+1,end+1+size));offset=end+1+size+1;}
 return symlinks.flatMap((row,index)=>{
  const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(row.path),targets[index])),link=links.find(link=>resolved.startsWith(link.path+'/'));
  return link?[{file:row.path,gitlink:link.path,revision:link.object,inner:resolved.slice(link.path.length+1)}]:[];
 });
}
/** The declared app files that are symlinks into one of the app's own gitlinks, each with that
 * gitlink as a Builds path: the gitlink is a source of whoever declares the file. */
export function appNestedFiles(entries,repository=root){
 const app=appSourceRoot(repository),checkout=path.relative(repository,app.directory).split(path.sep).join('/');
 return checkoutGitlinkFiles(app.directory,entries).map(row=>({...row,gitlink:checkout+'/'+row.gitlink}));
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
