import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readProjects} from '../lib/projects.mjs';
const exec=promisify(execFile);
const github=async args=>(await exec('gh',args,{encoding:'utf8',maxBuffer:32<<20})).stdout;

/** Older runs retained reports.json alone. Its input graph and the run's actual
 * matrix job identities recover the publishable targets without running recipes.
 * New runs retain the complete plan alongside those same definition reports. */
export async function retainedPublicationPlan({run,reports,plan,readCatalog}){
 if(plan)return {...plan,reports};
 const targets=run.jobs.flatMap(job=>{const match=/^build \((\S+) (\S+) (arm64|x64|universal)\)$/.exec(job.name);return match?[{project:match[1],version:match[2],arch:match[3]}]:[];});
 if(!targets.length)throw Error('The original run has no package build targets.');
 const selection=[...new Map(targets.map(row=>[row.project+'/'+row.version,{id:row.project,version:row.version}])).values()];
 const graph=Object.fromEntries(Object.entries(reports).map(([id,report])=>[id,report.inputs.map(input=>input.id)]));
 const selected=new Set(selection.map(row=>row.id)),required=new Set(Object.values(graph).flat()),reuse=[];
 for(const id of required)if(!selected.has(id)){
  const catalog=await readCatalog(id),record=catalog.packages[0];
  if(!record)throw Error('Original input catalog is empty: '+id);
  reuse.push({id,version:record.version,digest:record.asset.sha256});
 }
 const depth=id=>graph[id]?.length?1+Math.max(...graph[id].map(depth)):0;
 const independent={include:targets.filter(row=>depth(row.project)===0&&!required.has(row.project))};
 const matrices=Array.from({length:4},(_,level)=>({include:targets.filter(row=>depth(row.project)===level&&(level!==0||required.has(row.project)))}));
 if(targets.some(row=>depth(row.project)>3))throw Error('Original input chain exceeds the configured publication levels.');
 return {selection,graph,reuse,independent,matrices,reports};
}

/** All downloads occur in the clean hosted planner, never on a local computer. */
export async function preparePublishOnly({runId,output,directory,env=process.env,runGh=github}){
 const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==repository)throw Error('Publish-only planning runs on GitHub.');
 if(!/^[1-9][0-9]*$/.test(runId))throw Error('Publish-only needs a completed build run ID.');
 const run=JSON.parse(await runGh(['run','view',runId,'--repo',repository,'--json','databaseId,workflowName,headSha,headBranch,status,conclusion,jobs']));
 if(String(run.databaseId)!==runId||run.workflowName!=='Build and release'||run.headBranch!=='main'||run.status!=='completed'||run.conclusion==='cancelled'||!/^[a-f0-9]{40}$/.test(run.headSha))throw Error('Publish-only needs a completed Build and release run on main.');
 fs.mkdirSync(output,{recursive:true});
 await runGh(['run','download',runId,'--repo',repository,'--name','release-plan','--dir',output]);
 const reports=JSON.parse(fs.readFileSync(path.join(output,'reports.json'))),file=path.join(output,'plan.json');
 const saved=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):undefined;
 if(saved?.publicationRun&&saved.publicationRun!==runId)throw Error('Name the original build run, not a publish-only run.');
 const plan=await retainedPublicationPlan({run,reports,plan:saved,readCatalog:async id=>{
  const entry=JSON.parse(await runGh(['api','repos/'+repository+'/contents/catalogs/'+id+'.json?ref='+run.headSha]));
  return JSON.parse(Buffer.from(entry.content,'base64'));
 }});
 return {...plan,publicationRun:runId,publicationSource:run.headSha,publishOnly:true};
}
