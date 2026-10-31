import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {checkoutSource} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
const read=(source,args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();

/** Select one exact ART producer without coupling leaf profiles to the final runtime Gitlink. */
export function acquireArtProducer({source,work}){
 if(!path.isAbsolute(work||'')||!/^[a-f0-9]{40}$/.test(source?.revision||''))throw Error('An ART producer requires an exact source revision and absolute work path.');
 const directory=source.directory?path.join(root,source.directory):checkoutSource({...source,destination:path.join(work,'android-producer')});
 if(read(directory,['rev-parse','HEAD'])!==source.revision||read(directory,['status','--porcelain','--untracked-files=no']))throw Error('The ART producer differs from its selected immutable source.');
 return directory;
}
