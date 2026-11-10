import fs from 'node:fs';
import path from 'node:path';
import {run} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
/** A Python environment in the work directory holding the exact wheels of a tool lock. Each wheel is an
 * archive record the input step fetched; uv installs them without an index. */
export async function pythonBuildTools(work,lockFile){
 const lock=JSON.parse(fs.readFileSync(lockFile,'utf8')),environment=path.join(work,'tools'),python=path.join(environment,'bin/python'),wheels=path.join(work,'tool-wheels');
 if(!fs.existsSync(python))run('uv',['venv','--python',lock.python,environment]);
 fs.mkdirSync(wheels,{recursive:true});
 for(const row of lock.packages)fs.copyFileSync(await buildInput(row),path.join(wheels,path.posix.basename(new URL(row.url).pathname)));
 run('uv',['pip','install','--python',python,'--offline','--no-index','--find-links',wheels,'--no-deps',...lock.packages.map(row=>row.name+'=='+row.version)]);
 return {python,bin:path.join(environment,'bin')};
}
