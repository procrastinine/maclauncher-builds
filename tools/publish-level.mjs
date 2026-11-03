import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readProjects,resolveProject,buildRecord,buildRecords} from '../lib/projects.mjs';
import {registerSelection,parseSelection} from './release-selection.mjs';
import {publishPackage,appendPackageCatalog} from './publish-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
const github=async(args)=>(await exec('gh',args,{encoding:'utf8',maxBuffer:32<<20})).stdout;
const absent=error=>/HTTP 404|Not Found|release not found/i.test(String(error.stderr||error.message));
/** A clean publisher handles only its completed build level. Other levels and
 * components neither grant upstream code write access nor gate these releases. */
export async function publishLevel({targets,output,directory=root,env=process.env,runGh=github,publish=publishPackage,append=appendPackageCatalog,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==repository||env.GITHUB_WORKFLOW!=='Build and release'||env.GITHUB_WORKFLOW_REF!==repository+'/.github/workflows/runtime-build.yml@refs/heads/main'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID||''))throw Error('Publication requires the current hosted Build and release run.');
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Publication needs a new absolute work directory.');
 targets??=JSON.parse(env.PUBLICATION_TARGETS||'{}').include;
 if(!Array.isArray(targets)||!targets.length)throw Error('A publisher needs its exact planned level targets.');
 const selection=parseSelection(env.RELEASE_SELECTION),graph=JSON.parse(env.RELEASE_GRAPH||'{}'),reused=JSON.parse(env.RELEASE_REUSE||'[]'),seen=new Set();
 for(const target of targets){const key=[target.project,target.version,target.arch].join('/');if(seen.has(key)||!selection.some(row=>row.id===target.project&&row.version===target.version))throw Error('Publication target differs from the selection.');seen.add(key);}
 const sourceRevision=env.PUBLICATION_SOURCE_SHA||env.GITHUB_SHA,runId=env.PUBLICATION_RUN_ID||env.GITHUB_RUN_ID;
 const readRun=async()=>{
  const run=JSON.parse(await runGh(['run','view',runId,'--repo',repository,'--json','databaseId,workflowName,headSha,headBranch,status,conclusion,jobs']));
  if(String(run.databaseId)!==runId||run.headSha!==sourceRevision||run.headBranch!=='main'||run.workflowName!=='Build and release'||run.conclusion==='cancelled'||(runId!==env.GITHUB_RUN_ID&&run.status!=='completed'))throw Error('Publication metadata differs from this run.');
  return run;
 };
 let run=await readRun();
 const waitForBuild=async name=>{
  const waits=[2000,4000,8000,16000,30000];
  for(let attempt=0;;attempt++){
   const jobs=run.jobs.filter(job=>job.name===name);
   if(jobs.length===1&&jobs[0].status==='completed'){
    if(jobs[0].conclusion==='success')return;
    throw Error('Build job did not succeed: '+name);
   }
   if(jobs.length>1||attempt===waits.length)throw Error('Build job did not succeed: '+name);
   await sleep(waits[attempt]);run=await readRun();
  }
 };
 fs.mkdirSync(output,{recursive:true});const releases=new Map(),results=[],errors=[];let next=0,catalogTail=Promise.resolve();
 const serialAppend=options=>{const task=catalogTail.then(()=>append(options));catalogTail=task.catch(()=>{});return task;};
 const inputPublished=async(id,arch)=>{
  const selected=selection.find(row=>row.id===id),binding=selected||reused.find(row=>row.id===id);if(!binding)return false;
  const project=resolveProject(id,directory,{resolvePins:false});
  if(selected&&!buildRecords(project).some(build=>build.version===selected.version))registerSelection({selection:[selected],directory});
  const cpus=selected?buildRecord(resolveProject(id,directory,{resolvePins:false}),selected.version).architectures:[arch,'universal','arm64'];
  const cpu=cpus.includes(arch)?arch:cpus.includes('universal')?'universal':cpus[0],tag=id+'/v'+binding.version+'/'+cpu;
  if(!releases.has(tag))releases.set(tag,(async()=>{try{const release=JSON.parse(await runGh(['api','repos/'+repository+'/releases/tags/'+encodeURIComponent(tag)]));return release.tag_name===tag&&!release.draft;}catch(error){if(absent(error))return false;throw error;}})());
  return releases.get(tag);
 };
 await Promise.all(Array.from({length:Math.min(8,targets.length)},async()=>{for(;;){const index=next++;if(index>=targets.length)return;const target=targets[index];try{
  const name='build ('+[target.project,target.version,target.arch].join(' ')+')';
  await waitForBuild(name);
  for(const input of graph[target.project]||[])if(!await inputPublished(input,target.arch))throw Error('Required input is not published: '+input);
  const bundle=path.join(output,target.project,target.version,target.arch);fs.mkdirSync(bundle,{recursive:true});
  await runGh(['run','download',runId,'--repo',repository,'--name','runtime-'+[target.project,target.version,target.arch].join('-'),'--dir',bundle]);
  const result=await publish({bundle,directory,env:{...env,BUILD_PROJECT:target.project,BUILD_VERSION:target.version,BUILD_ARCH:target.arch},runGh,append:serialAppend});results.push({...target,...result});
 }catch(error){errors.push({...target,error:error.message});}}}));
 const result={selected:targets.length,published:results.length,failed:errors.length,results,errors};fs.writeFileSync(path.join(output,'publication-result.json'),JSON.stringify(result,null,2)+'\n');
 if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'\nPublished '+result.published+'/'+result.selected+' packages in this level.\n'+errors.map(row=>'- '+row.project+' '+row.version+' '+row.arch+': '+row.error).join('\n')+'\n');
 return result;
}
export async function main(args,options={}){if(args.length!==2||args[0]!=='--output')throw Error('Use --output /absolute/work-directory.');return publishLevel({...options,output:args[1]});}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
