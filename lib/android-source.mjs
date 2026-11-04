import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gitlink} from './pins.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
/** Every Android producer uses the repository's one selected source gitlink. */
export function androidSource(){
 const {repository,path:directory}=JSON.parse(fs.readFileSync(new URL('../runtimes/android/source.json',import.meta.url)));
 return {repository,revision:gitlink(directory),directory};
}
export const androidSourceJson=file=>JSON.parse(fs.readFileSync(path.join(root,androidSource().directory,file)));
export const aimSource=()=>({repository:'https://github.com/hahnlee/aim',revision:gitlink('producers/maclauncher/src/external/aim')});
export const ndkSource=()=>JSON.parse(fs.readFileSync(new URL('../producers/android-inputs/aim.json',import.meta.url))).ndk;
