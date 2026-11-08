import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
export const gitlink=directory=>{const prefix='sources/maclauncher/';return execFileSync('git',['-C',directory.startsWith(prefix)?root+'sources/maclauncher':root,'rev-parse','HEAD:'+(directory.startsWith(prefix)?directory.slice(prefix.length):directory)],{encoding:'utf8'}).trim();};
