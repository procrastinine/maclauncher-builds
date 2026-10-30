import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {identity} from '../lib/project-identity.mjs';

/** A completed matrix run can contain independent successful packages. */
export function verifiedBuildSource(run,{project,version,arch}) {
 identity({id:project,version,arch});
 if(run?.workflowName!=='Runtime build'||run.status!=='completed'||run.headBranch!=='main'||!(/^[a-f0-9]{40}$/).test(run.headSha||''))throw Error('Select a completed Runtime build from main.');
 const name='build ('+[project,version,arch].join(' ')+')',jobs=Array.isArray(run.jobs)?run.jobs.filter(job=>job.name===name):[];
 if(jobs.length!==1||jobs[0].status!=='completed'||jobs[0].conclusion!=='success')throw Error('The selected package has no successful Runtime build job.');
 return run.headSha;
}
export function main(args) {
 const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['input','project','version','arch'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --input, --project, --version and --arch.');options[key]=args[i+1];}
 return verifiedBuildSource(JSON.parse(fs.readFileSync(options.input)),options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(main(process.argv.slice(2)));}catch(error){console.error(error.message);process.exitCode=1;}}
