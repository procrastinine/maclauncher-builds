import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gitlink} from './pins.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
/** The default Android producer comes from the repository's selected source gitlink. */
export function androidSource(){
 const {repository,path:directory}=JSON.parse(fs.readFileSync(new URL('../runtimes/android/source.json',import.meta.url)));
 return {repository,revision:gitlink(directory),directory};
}
export const androidSourceJson=file=>JSON.parse(fs.readFileSync(path.join(root,androidSource().directory,file)));
export const aimSource=()=>{const {repository,revision}=androidUpstream('https://github.com/hahnlee/aim');return {repository,revision};};
export const ndkSource=()=>JSON.parse(fs.readFileSync(new URL('../producers/android-inputs/aim.json',import.meta.url))).ndk;
export const androidUpstream=repository=>androidSourceJson('upstreams.json').projects.find(source=>source.repository.replace(/\.git$/,'')===repository.replace(/\.git$/,''));
