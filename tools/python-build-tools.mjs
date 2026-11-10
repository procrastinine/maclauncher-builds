import fs from 'node:fs';
import path from 'node:path';
import {run} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
const lockFile=path.join(import.meta.dirname,'python-build-tools.json');
/** The exact tool versions of one set in the Python build tool lock, by tool name in the set's order. */
export function pythonToolVersions(set){
 const lock=JSON.parse(fs.readFileSync(lockFile,'utf8'));
 return Object.fromEntries(lock.sets[set].map(name=>[name,lock.wheels.find(row=>row.name===name).version]));
}
/** A Python environment, by default in the work directory, holding one tool set of the Python build tool lock.
 * Each wheel is an archive record the input step fetched; a tool can have one wheel per build platform, and
 * uv installs the compatible one without an index. */
export async function pythonBuildTools(work,set,environment=path.join(work,'tools')){
 const lock=JSON.parse(fs.readFileSync(lockFile,'utf8')),names=lock.sets[set];if(!names)throw Error('The Python build tool lock has no set '+set+'.');
 const python=path.join(environment,'bin/python'),wheels=path.join(work,'tool-wheels');
 if(!fs.existsSync(python))run('uv',['venv','--python',lock.python,environment]);
 fs.mkdirSync(wheels,{recursive:true});
 for(const row of lock.wheels.filter(row=>names.includes(row.name)))fs.copyFileSync(await buildInput(row),path.join(wheels,path.posix.basename(new URL(row.url).pathname)));
 run('uv',['pip','install','--python',python,'--offline','--no-index','--find-links',wheels,'--no-deps',...Object.entries(pythonToolVersions(set)).map(([name,version])=>name+'=='+version)]);
 return {python,bin:path.join(environment,'bin')};
}
