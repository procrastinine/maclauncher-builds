import './producer-environment.mjs';
import {identity} from '../lib/project-identity.mjs';

/** A package is selected only from its successful job in the current build workflow. */
export function verifiedBuildSource(run,{project,version,arch,sourceRevision}){
 identity({id:project,version,arch});
 if(run?.workflowName!=='Build and release'||!['in_progress','completed'].includes(run.status)||run.conclusion==='cancelled'||run.headBranch!=='main'||!(/^[a-f0-9]{40}$/).test(run.headSha||'')||sourceRevision&&run.headSha!==sourceRevision)throw Error('Select the current Build and release source from main.');
 const name='build ('+[project,version,arch].join(' ')+')',jobs=Array.isArray(run.jobs)?run.jobs.filter(job=>job.name===name):[];
 if(jobs.length!==1||jobs[0].status!=='completed'||jobs[0].conclusion!=='success')throw Error('The selected package has no successful current build job.');
 return run.headSha;
}
