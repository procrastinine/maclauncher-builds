import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {checkoutSource} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');

/** Select one exact ART producer without coupling leaf profiles to the final runtime Gitlink. */
export function acquireArtProducer({source,work}){
 if(!path.isAbsolute(work||'')||!/^[a-f0-9]{40}$/.test(source?.revision||''))throw Error('An ART producer requires an exact source revision and absolute work path.');
 const directory=source.directory?path.join(root,source.directory):checkoutSource({...source,destination:path.join(work,'android-producer')});
 return directory;
}
