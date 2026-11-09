import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowJobs,runJob} from './helpers/job-standin.mjs';

// P1 (run 42531180192): each hosted job, from a fresh checkout of the tested commit with only
// the sources its own steps prepare, loads every tool it runs and generates the index.
for(const job of workflowJobs('HEAD'))test('job stand-in: '+job.workflow+'/'+job.job,t=>{
 const result=runJob({job});
 if(/has no initialized checkout/.test(result.error||''))return t.skip(result.error);
 assert.equal(result.error,null);
 if(job.steps.some(step=>/npm run index:build/.test(step)))assert.ok(result.index?.packages>0);
});
