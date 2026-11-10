import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceCheckout,sourceRevision} from './pins.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
/** The default Android producer comes from the repository's selected source gitlink. */
export function androidSource(){
 const recipe=JSON.parse(fs.readFileSync(new URL('../runtimes/android/source.json',import.meta.url))),repository=recipe.repository,directory=sourceCheckout(recipe);
 return {repository,revision:sourceRevision(recipe),directory};
}
export const androidSourceJson=file=>JSON.parse(fs.readFileSync(path.join(root,androidSource().directory,file)));
/** AIM is the Android source's own gitlink; Builds reads it in place there, at the commit it records. */
export const aimRecord=()=>({gitlink:path.posix.join(androidSource().directory,androidUpstream('https://github.com/hahnlee/aim').path)});
export const aimSource=()=>({repository:androidUpstream('https://github.com/hahnlee/aim').repository,revision:sourceRevision(aimRecord())});
export const ndkSource=()=>JSON.parse(fs.readFileSync(new URL('../producers/android-inputs/aim.json',import.meta.url))).ndk;
export const androidUpstream=repository=>androidSourceJson('upstreams.json').projects.find(source=>source.repository.replace(/\.git$/,'')===repository.replace(/\.git$/,''));
