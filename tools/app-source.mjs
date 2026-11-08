import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const profile=JSON.parse(fs.readFileSync(path.join(root,'producers/package-support/app-source.json')));
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:Infinity}).trim();
/** The app is the source authority; the producer consumes its exact clean pin. */
export function appSourceRoot(){
 const directory=path.join(root,profile.gitlink);
 if(!/^[a-f0-9]{40}$/.test(profile.revision)||git(root,['rev-parse','HEAD:'+profile.gitlink])!==profile.revision||git(directory,['rev-parse','HEAD'])!==profile.revision)throw Error('Initialize the exact declared MacLauncher app source pin.');
 if(git(directory,['status','--porcelain','--untracked-files=no','--ignore-submodules=all']))throw Error('The pinned app source has tracked changes.');
 const origin=git(directory,['remote','get-url','origin']).replace(/^git@github.com:/,'https://github.com/').replace(/\.git$/,'').replace(/\/$/,'');
 if(origin!==profile.repository)throw Error('The app source origin differs from its public declaration.');
 return {directory,revision:profile.revision};
}
/** Export committed module bytes; ignored local files never enter the build. */
export function materializeAppModule({module,output}){
 if(!profile.modules.includes(module)||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Choose a declared app module and a new absolute source directory.');
 const source=appSourceRoot(),archive=execFileSync('git',['-C',source.directory,'archive','--format=tar',source.revision+':'+module],{maxBuffer:Infinity});
 fs.mkdirSync(output,{recursive:true});
 try{execFileSync('/usr/bin/tar',['-xf','-','-C',output],{input:archive,stdio:['pipe','pipe','pipe']});return {...source,output};}
 catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}

/** Inputs are read directly from the pinned app checkout. */
export function materializeProducerSourceLinks(){ appSourceRoot(); return ()=>{}; }
