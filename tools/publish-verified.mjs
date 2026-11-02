import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readProjects,resolveProject,buildRecord} from '../lib/projects.mjs';
import {parseSelection} from './release-selection.mjs';
import {verifiedBuildSource} from './verified-build-run.mjs';
import {recordGithubBuild} from './record-github-build.mjs';
import {requireGithubBuild} from './build-coverage.mjs';
import {prepareRelease,verifyRelease,stageRelease,publishRelease,applyRelease} from './release-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
const runGitHub=async(args,options={})=>{if(process.env.GITHUB_ACTIONS!=='true')throw Error('Release transport runs only inside GitHub Actions.');return (await exec('gh',args,{encoding:'utf8',maxBuffer:64*1024**2,...options})).stdout;};
async function parallel(items,worker){const results=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(8,items.length)},async()=>{for(;;){const index=next++;if(index>=items.length)return;try{results[index]={ok:true,value:await worker(items[index])};}catch(error){results[index]={ok:false,item:items[index],error:error.message};}}}));return results;}

/** Release only designated packages built by this same hosted workflow run. */
export async function publishCurrentRun({selection,output,directory=root,env=process.env,runGh=runGitHub,
 verifyBundle=verifyRelease,recordBuild=recordGithubBuild,requireBuild=requireGithubBuild,prepareBundle=prepareRelease,
 stageBundle=stageRelease,publishBundle=publishRelease,applyBundle=applyRelease}={}){
 if(env.GITHUB_ACTIONS!=='true'||!(/^[1-9][0-9]{0,19}$/).test(env.GITHUB_RUN_ID||'')||!(/^[a-f0-9]{40}$/).test(env.GITHUB_SHA||''))throw Error('Release runs only inside the current GitHub Actions build.');
 directory=fs.realpathSync(directory);const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_REPOSITORY!==repository||env.GITHUB_WORKFLOW!=='Build and release'||env.GITHUB_WORKFLOW_REF!==repository+'/.github/workflows/runtime-build.yml@refs/heads/main')throw Error('Release requires the current Build and release workflow from main.');
 if(!path.isAbsolute(output||''))throw Error('Select an absolute release output directory.');output=path.resolve(output);
 if(output===directory||output.startsWith(directory+path.sep)||directory.startsWith(output+path.sep))throw Error('Keep release output outside the source checkout.');
 const requested=parseSelection(selection??env.RELEASE_SELECTION),include=[],graph=JSON.parse(env.RELEASE_GRAPH||'{}'),reports=JSON.parse(env.BUILD_REPORTS?(env.BUILD_REPORTS.trim().startsWith('{')?env.BUILD_REPORTS:fs.readFileSync(env.BUILD_REPORTS,'utf8')):'{}');
 const selectedIds=new Set(requested.map(row=>row.id)),depths=new Map(),visiting=new Set();
 const depth=id=>{if(depths.has(id))return depths.get(id);if(visiting.has(id))throw Error('Selected package inputs form a cycle.');visiting.add(id);const inputs=(graph[id]||[]).filter(input=>selectedIds.has(input)),value=inputs.length?1+Math.max(...inputs.map(depth)):0;visiting.delete(id);depths.set(id,value);return value;};for(const id of selectedIds)depth(id);
 for(const {id,version} of requested){if(!version)throw Error('Release selection must contain its registered exact versions.');const project=resolveProject(id,directory,{resolvePins:false}),build=buildRecord(project,version);for(const arch of build.architectures)include.push({project:id,version,arch});}
 const run=JSON.parse(await runGh(['run','view',env.GITHUB_RUN_ID,'--repo',repository,'--json','databaseId,workflowName,headSha,headBranch,status,conclusion,jobs']));
 if(String(run.databaseId)!==env.GITHUB_RUN_ID||run.headSha!==env.GITHUB_SHA||run.workflowName!=='Build and release'||run.headBranch!=='main'||!['in_progress','completed'].includes(run.status)||run.conclusion==='cancelled')throw Error('Release metadata does not identify this current workflow run.');
 const successful=[],errors=[];
 for(const target of include){const name='build ('+[target.project,target.version,target.arch].join(' ')+')',jobs=run.jobs?.filter(job=>job.name===name)||[];if(jobs.length!==1||jobs[0].status!=='completed')throw Error('All designated build jobs must finish before release: '+name);if(jobs[0].conclusion==='success'){successful.push({...target,sourceRevision:verifiedBuildSource(run,{...target,sourceRevision:env.GITHUB_SHA})});}else errors.push({...target,phase:'build',error:'Build job concluded '+jobs[0].conclusion});}
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'publication-plan.json'),JSON.stringify({repository,runId:env.GITHUB_RUN_ID,sourceRevision:env.GITHUB_SHA,selection:requested,packages:successful},null,2)+'\n');
 let catalogTail=Promise.resolve();const apply=options=>{const task=catalogTail.then(()=>applyBundle(options));catalogTail=task.catch(()=>{});return task;};
 const failedInputs=new Set(errors.map(error=>error.project)),settled=[];
 for(const level of [...new Set(successful.map(target=>depth(target.project)))].sort((a,b)=>a-b)){
  const candidates=[];for(const target of successful.filter(target=>depth(target.project)===level)){const blockedBy=(graph[target.project]||[]).filter(input=>selectedIds.has(input)&&failedInputs.has(input));if(blockedBy.length){errors.push({...target,phase:'input-release',blockedBy,error:'Selected inputs were not published: '+blockedBy.join(', ')});failedInputs.add(target.project);}else candidates.push(target);}
  const released=await parallel(candidates,async target=>{
  const {project,version,arch}=target,download=path.join(output,'downloads',project,version,arch);fs.mkdirSync(download,{recursive:true});
  await runGh(['run','download',env.GITHUB_RUN_ID,'--repo',repository,'--name','runtime-'+[project,version,arch].join('-'),'--dir',download]);
  const {record,declaration}=await verifyBundle({bundle:download,project,version,arch,directory,includeDeclaration:true});
  if(env.BUILD_REPORTS){const expected=reports[project]?.definitionDigest,file=declaration?.files?.find(file=>file.path==='build-definition.json');if(!expected||file?.sha256!==expected)throw Error('The sealed build definition differs from this planned package.');}
  if(record.id!==project||record.version!==version||record.arch!==arch||record.build?.sourceRevision!==env.GITHUB_SHA||String(record.build?.runId)!==env.GITHUB_RUN_ID)throw Error('The archive does not belong to this selected current build.');
  const archive=path.join(download,record.asset.filename);await recordBuild({archive,record,directory,runGh:(command,args,options)=>{if(command!=='gh')throw Error('Unexpected attestation transport.');return runGh(args,options);}});
  const ledger=path.join(output,'staged-ledgers');fs.mkdirSync(ledger,{recursive:true});fs.copyFileSync(path.join(directory,'attestations',record.asset.sha256+'.json'),path.join(ledger,record.asset.sha256+'.json'));
  requireBuild({record,repository,directory,archive,sourceRevision:env.GITHUB_SHA});
  const bundle=path.join(output,'bundles',project,version,arch);await prepareBundle({project,archive,record,output:bundle,directory});
  const options={bundle,directory,runGh};await stageBundle({...options,target:env.GITHUB_SHA,resume:true});await publishBundle(options);await apply(options);
  return {...target,sha256:record.asset.sha256,runId:env.GITHUB_RUN_ID,bundle,published:true};
  });
  settled.push(...released);for(const item of released)if(!item.ok)failedInputs.add(item.item.project);
 }
 const results=settled.filter(item=>item.ok).map(item=>item.value);errors.push(...settled.filter(item=>!item.ok).map(item=>({...item.item,phase:'release',error:item.error})));
 const result={schemaVersion:1,selected:include.length,published:results.length,failed:errors.length,results,errors};fs.writeFileSync(path.join(output,'publication-result.json'),JSON.stringify(result,null,2)+'\n');return result;
}
export function main(args,options={}){if(args.length!==2||args[0]!=='--output'||!args[1])throw Error('Use --output /absolute/path; selection and build identity come from this workflow.');return publishCurrentRun({...options,output:args[1]});}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
