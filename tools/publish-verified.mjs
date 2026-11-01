import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {buildCoverage,requireGithubBuild} from './build-coverage.mjs';
import {releaseTag} from '../lib/project-identity.mjs';
import {readProjects,resolveProject,buildRecord,buildRecords} from '../lib/projects.mjs';
import {verifiedBuildSource} from './verified-build-run.mjs';
import {recordGithubBuild} from './record-github-build.mjs';
import {prepareRelease,verifyRelease,stageRelease,verifyRemoteRelease,publishRelease,applyRelease} from './release-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile),identity=row=>[row.project||row.id,row.version,row.arch].join('/');
const runGitHub=async(args,options={})=>{if(process.env.GITHUB_ACTIONS!=='true')throw Error('Real publication transport runs only inside GitHub Actions.');return (await exec('gh',args,{encoding:'utf8',maxBuffer:64*1024**2,...options})).stdout;};

/** Independent failures are retained after every bounded worker has finished. */
export async function settlePackages(items,worker,{concurrency=8}={}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('Package concurrency must be between one and eight.');
 const results=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{for(;;){const index=next++;if(index>=items.length)return;try{results[index]={ok:true,value:await worker(items[index],index)};}catch(error){results[index]={ok:false,error,errorMessage:error.message,item:items[index]};}}}));return results;
}

/** Successful matrix identities still require the exact workflow/source and declared profile. */
export function successfulRunTargets(run,{directory=root,project,version,arch='all'}={}){
 if(run?.workflowName!=='Runtime build'||run.status!=='completed'||run.headBranch!=='main'||!(/^[a-f0-9]{40}$/).test(run.headSha||''))throw Error('Select a completed Runtime build from main.');
 if(project||version){
  if(!project||!version)throw Error('Select both project and version.');
  const registration=resolveProject(project,directory,{resolvePins:false});let build;
  try{build=buildRecord(registration,version);}catch(error){if(!registration.packageProfiles?.some(profile=>profile.version===version))throw error;}
  const cpus=build?(arch==='all'?build.architectures:[arch]):arch==='all'?run.jobs.filter(job=>job.status==='completed'&&job.conclusion==='success').flatMap(job=>{const match=/^build \(([^ ]+) ([^ ]+) (arm64|x64|universal)\)$/.exec(job.name);return match&&match[1]===project&&match[2]===version?[match[3]]:[];}):[arch];
  if(build&&arch!=='all'&&!build.architectures.includes(arch))throw Error('Select a declared package version and architecture.');
  if(!cpus.length)throw Error('The selected package has no successful Runtime build job.');
  return cpus.map(arch=>({project,version,arch,sourceRevision:verifiedBuildSource(run,{project,version,arch})}));
 }
 if(arch!=='all')throw Error('Architecture selection requires project and version.');
 const targets=[];
 for(const job of run.jobs||[]){if(job.status!=='completed'||job.conclusion!=='success'||!job.name?.startsWith('build ('))continue;
  const match=/^build \(([^ ]+) ([^ ]+) (arm64|x64|universal)\)$/.exec(job.name);if(!match)throw Error('Unrecognized successful Runtime matrix identity.');
  const [,project,version,arch]=match;targets.push({project,version,arch,sourceRevision:verifiedBuildSource(run,{project,version,arch})});
 }
 return targets;
}
/** Automatic catch-up selects only current registered build identities and their newest successful run. */
export function latestCurrentRunTargets(runs,{directory=root,publishedIdentities=new Set()}={}){
 const allowed=new Set(readProjects(directory,{resolvePins:false}).projects.filter(project=>!project.supersededBy&&project.build!==undefined).flatMap(project=>buildRecords(project).flatMap(build=>build.architectures.map(arch=>[project.id,build.version,arch].join('/'))))),selected=new Map();
 const newer=(a,b)=>{const at=Date.parse(a.run.createdAt),bt=Date.parse(b.run.createdAt);if(Number.isFinite(at)&&Number.isFinite(bt)&&at!==bt)return at>bt;return BigInt(a.buildRun)>BigInt(b.buildRun);};
 for(const entry of runs)for(const target of successfulRunTargets(entry.run,{directory})){
  const key=identity(target);if(!allowed.has(key)||publishedIdentities.has(key))continue;
  const candidate={...target,buildRun:String(entry.buildRun),run:entry.run},old=selected.get(key);if(!old||newer(candidate,old))selected.set(key,candidate);
 }
 return [...selected.values()];
}
function validateTarget(target,directory){const registration=resolveProject(target.project,directory,{resolvePins:false});let build;try{build=buildRecord(registration,target.version);}catch(error){if(!registration.packageProfiles?.some(profile=>profile.version===target.version))throw error;}
 if(build&&!build.architectures.includes(target.arch))throw Error('Select a declared architecture.');return registration;}
const errorResult=(item,error)=>({project:item.project,version:item.version,arch:item.arch,buildRun:item.buildRun,error:error.message});

/** Imports original hosted artifacts and strict signed ledgers without changing catalogs. */
export async function importVerifiedRun({buildRun,project,version,arch='all',output,directory=root,runGh=runGitHub,
 verifyBundle=verifyRelease,recordBuild=recordGithubBuild,continueOnError=false,publishedIdentities=new Set(),runMetadata,concurrency=8,importSlot=task=>task(),targetIdentities}){
 if(!/^[1-9][0-9]{0,19}$/.test(buildRun||''))throw Error('Select an exact Runtime build run.');
 if(!path.isAbsolute(output||''))throw Error('Select an absolute publication output directory.');
 const repository=readProjects(directory,{resolvePins:false}).repository;
 const run=runMetadata??JSON.parse(await runGh(['run','view',buildRun,'--repo',repository,'--json','workflowName,headSha,headBranch,status,jobs']));
 if(!runMetadata&&!project&&!version){const origin=JSON.parse(await runGh(['api','repos/'+repository+'/actions/runs/'+buildRun,'--jq','{repository: .repository.full_name, headRepository: .head_repository.full_name}']));if(origin.repository!==repository||origin.headRepository!==repository)throw Error('The Runtime build run belongs to a foreign source repository.');}
 const targets=successfulRunTargets(run,{directory,project,version,arch}).filter(target=>!targetIdentities||targetIdentities.has(identity(target))),skipped=targets.filter(target=>publishedIdentities.has(identity(target)+'/'+target.sourceRevision+'/'+buildRun)),pending=targets.filter(target=>!publishedIdentities.has(identity(target)+'/'+target.sourceRevision+'/'+buildRun));
 const settled=await settlePackages(pending,target=>importSlot(async()=>{
  const {project,version,arch}=target;validateTarget(target,directory);
  const download=path.join(output,'downloads',project,version,arch);fs.mkdirSync(download,{recursive:true});
  await runGh(['run','download',buildRun,'--repo',repository,'--name','runtime-'+[project,version,arch].join('-'),'--dir',download]);
  const {record}=await verifyBundle({bundle:download,project,version,arch,directory});
  if(record.id!==project||record.version!==version||record.arch!==arch||record.build?.sourceRevision!==target.sourceRevision||String(record.build?.runId)!==buildRun)throw Error('The downloaded package names a different source or build run.');
  await recordBuild({archive:path.join(download,record.asset.filename),record,directory,runGh:(command,args,options)=>{if(command!=='gh')throw Error('Unexpected attestation transport.');return runGh(args,options);}});
  const ledger=path.join(output,'staged-ledgers');fs.mkdirSync(ledger,{recursive:true});fs.copyFileSync(path.join(directory,'attestations',record.asset.sha256+'.json'),path.join(ledger,record.asset.sha256+'.json'));
  return {project,version,arch,sourceRevision:target.sourceRevision,sha256:record.asset.sha256};
 }),{concurrency});
 const results=settled.filter(row=>row.ok).map(row=>row.value),errors=settled.flatMap(row=>row.ok?[]:[errorResult({...row.item,buildRun},row.error)]);
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'imported-builds.json'),JSON.stringify(results,null,2)+'\n');fs.writeFileSync(path.join(output,'import-errors.json'),JSON.stringify(errors,null,2)+'\n');
 if(errors.length&&!continueOnError)throw new AggregateError(settled.filter(row=>!row.ok).map(row=>row.error),'Runtime import failed: '+errors.map(row=>row.error).join('; '));
 return continueOnError?{results,errors,skipped}:results;
}

/** Enumerate all pages rather than silently losing runs after a fixed list limit. */
export async function catchUpBuildRuns({repository,runGh=runGitHub,now=new Date()}){
 const since=new Date(now.getTime()-7*86400000).toISOString(),route='repos/'+repository+'/actions/workflows/runtime-build.yml/runs?branch=main&status=completed&created='+encodeURIComponent('>='+since)+'&per_page=100';
 const text=await runGh(['api',route,'--paginate','--jq','.workflow_runs[].id']);return [...new Set(String(text).split(/\s+/).filter(Boolean))].map(id=>{if(!/^[1-9][0-9]{0,19}$/.test(id))throw Error('Invalid Runtime build run identifier.');return id;});
}

/** Publish independent packages in parallel; serialize shared catalog writes. */
export async function publishVerified({output,dryRun=false,buildRun,project,version,arch='all',catchUp,directory=root,runGh=runGitHub}){
 if(!path.isAbsolute(output||'')||typeof dryRun!=='boolean')throw Error('Select an absolute output directory and optional --dry-run.');
 directory=fs.realpathSync(directory);output=path.resolve(output);
 if(output===directory||output.startsWith(directory+path.sep)||directory.startsWith(output+path.sep))throw Error('Keep publication output outside the source checkout.');
 const initial=buildCoverage(directory),errors=[],selectedImports=new Set();
 fs.mkdirSync(output,{recursive:true});
 if(buildRun){
  const published=new Set(initial.githubBuilds.filter(row=>row.catalogPublished).map(row=>identity(row.record)+'/'+row.sourceRevision+'/'+row.runId)),runOnly=!project&&!version;
  let caught=[];if(catchUp??runOnly)try{caught=await catchUpBuildRuns({repository:initial.repository,runGh});}catch(error){errors.push({phase:'catch-up',error:error.message});}
  const runs=[...new Set([String(buildRun),...caught])];
  let active=0;const waiting=[];const importSlot=async task=>{if(active<8)active++;else await new Promise(resolve=>waiting.push(resolve));try{return await task();}finally{if(waiting.length)waiting.shift()();else active--;}};
  // Discover before downloading: historical profiles and older retries never enter automatic publication.
  let imported;
  if(runOnly){
   const discovered=await settlePackages(runs,async id=>{
    const run=JSON.parse(await runGh(['run','view',id,'--repo',initial.repository,'--json','workflowName,headSha,headBranch,status,jobs,createdAt']));
    const origin=JSON.parse(await runGh(['api','repos/'+initial.repository+'/actions/runs/'+id,'--jq','{repository: .repository.full_name, headRepository: .head_repository.full_name}']));
    if(origin.repository!==initial.repository||origin.headRepository!==initial.repository)throw Error('The Runtime build run belongs to a foreign source repository.');
    successfulRunTargets(run,{directory});return {buildRun:id,run};
   });
   for(const item of discovered)if(!item.ok)errors.push({phase:'discovery',buildRun:item.item,error:item.error.message});
   const alreadyPublished=new Set(initial.githubBuilds.filter(row=>row.catalogPublished).map(row=>identity(row.record))),targets=latestCurrentRunTargets(discovered.filter(item=>item.ok).map(item=>item.value),{directory,publishedIdentities:alreadyPublished}),groups=new Map();
   for(const target of targets){if(!groups.has(target.buildRun))groups.set(target.buildRun,{buildRun:target.buildRun,run:target.run,identities:new Set()});groups.get(target.buildRun).identities.add(identity(target));}
   imported=await settlePackages([...groups.values()],async group=>importVerifiedRun({buildRun:group.buildRun,runMetadata:group.run,targetIdentities:group.identities,output:path.join(output,'runs',group.buildRun),directory,runGh,continueOnError:true,publishedIdentities:published,concurrency:8,importSlot}));
  }else imported=await settlePackages(runs,async id=>importVerifiedRun({buildRun:id,project,version,arch,output:path.join(output,'runs',id),directory,runGh,continueOnError:true,publishedIdentities:published,concurrency:8,importSlot}));
  for(const row of imported){if(!row.ok){errors.push({phase:'import',error:row.error.message,buildRun:row.item});continue;}errors.push(...row.value.errors.map(error=>({phase:'import',...error})));for(const item of row.value.results)selectedImports.add(identity(item)+'/'+item.sha256);}
  // Keep each run's original downloads separate: repeated identities cannot overwrite bytes.
  for(const id of runs){const ledgers=path.join(output,'runs',id,'staged-ledgers');if(fs.existsSync(ledgers))fs.cpSync(ledgers,path.join(output,'staged-ledgers'),{recursive:true});}
 }else if(project||version||arch!=='all'||catchUp)throw Error('Selection and catch-up require --build-run.');
 const coverage=buildCoverage(directory),rows=coverage.githubBuilds.filter(row=>row.projectState==='active'&&!row.catalogPublished&&(!buildRun||selectedImports.has(identity(row.record)+'/'+row.record.asset.sha256)));
 const plan={repository:coverage.repository,dryRun,packages:rows.map(({record,sourceRevision,runId,runAttempt})=>({record,sourceRevision,runId,runAttempt}))};fs.writeFileSync(path.join(output,'publication-plan.json'),JSON.stringify(plan,null,2)+'\n');
 const locks=new Map();
 const apply=async(_id,options)=>{const id="catalogs";const previous=locks.get(id)||Promise.resolve();let release;const current=new Promise(resolve=>{release=resolve;});locks.set(id,current);await previous;try{return await applyRelease(options);}finally{release();if(locks.get(id)===current)locks.delete(id);}};
 const settled=await settlePackages(rows,async row=>{
  const {record}=row,importedDownload=path.join(output,'runs',String(row.runId),'downloads',record.id,record.version,record.arch),download=fs.existsSync(importedDownload)?importedDownload:path.join(output,'downloads',record.id,record.version,record.arch),bundle=path.join(output,'bundles',record.id,record.version,record.arch,record.asset.sha256);fs.mkdirSync(download,{recursive:true});
  const archive=path.join(download,record.asset.filename);
  if(!fs.existsSync(archive)){try{await runGh(['run','download',row.runId,'--repo',coverage.repository,'--name','runtime-'+[record.id,record.version,record.arch].join('-'),'--dir',download]);}catch(error){try{await runGh(['release','download',releaseTag(record),'--repo',coverage.repository,'--pattern',record.asset.filename,'--dir',download]);}catch(releasedError){throw Error('The build artifact and existing release archive are unavailable.',{cause:new AggregateError([error,releasedError])});}}}
  requireGithubBuild({record,repository:coverage.repository,directory,archive});await prepareRelease({project:record.id,archive,record,output:bundle,directory});await verifyRelease({bundle,directory});
  if(!dryRun){const options={bundle,directory,runGh};await stageRelease({...options,target:row.sourceRevision,resume:true});await verifyRemoteRelease(options);await publishRelease(options);await verifyRemoteRelease({...options,requirePublic:true});await apply(record.id,options);}
  const value={project:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256,sourceRevision:row.sourceRevision,runId:row.runId,bundle,published:!dryRun};console.log(JSON.stringify(value));return value;
 });
 const results=settled.filter(row=>row.ok).map(row=>row.value);errors.push(...settled.flatMap(row=>row.ok?[]:[{phase:'publication',...errorResult({...row.item.record,project:row.item.record.id,buildRun:row.item.runId},row.error)}]));
 const result={schemaVersion:1,dryRun,selected:rows.length,published:dryRun?0:results.length,failed:errors.length,results,errors,failedPackages:errors};fs.writeFileSync(path.join(output,'publication-result.json'),JSON.stringify(result,null,2)+'\n');return result;
}
export function main(args,{env=process.env,...options}={}){
 if(env.GITHUB_ACTIONS!=='true')throw Error('Verified batches are published only by the Runtime release workflow on GitHub.');
 const selected={};for(let i=0;i<args.length;i++){const key=args[i];if(['--dry-run','--catch-up'].includes(key)){const name=key==='--dry-run'?'dryRun':'catchUp';if(Object.hasOwn(selected,name))throw Error('Use '+key+' only once.');selected[name]=true;}else if(['--output','--build-run','--project','--version','--arch'].includes(key)&&args[i+1]){const name=key==='--build-run'?'buildRun':key.slice(2);if(Object.hasOwn(selected,name))throw Error('Duplicate '+key+'.');selected[name]=args[++i];}else throw Error('Use --output /absolute/path, optional --dry-run/--catch-up, or --build-run with optional --project, --version and --arch.');}
 return publishVerified({...selected,...options});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>{console.log(JSON.stringify({dryRun:value.dryRun,selected:value.selected,published:value.published,failed:value.failed}));if(value.failed)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
