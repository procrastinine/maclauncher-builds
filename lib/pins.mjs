import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
/** The commit Builds records for a submodule path. */
export const gitlink=directory=>execFileSync('git',['-C',root,'rev-parse','HEAD:'+directory],{encoding:'utf8'}).trim();
