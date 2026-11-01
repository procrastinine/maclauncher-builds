import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildCoverage,requireGithubBuild} from './build-coverage.mjs';
import {releaseTag} from '../lib/project-identity.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {verifiedBuildSource} from './verified-build-run.mjs';
import {recordGithubBuild} from './record-github-build.mjs';
import {prepareRelease,verifyRelease,stageRelease,verifyRemoteRelease,publishRelease,applyRelease} from './release-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const runGitHub=(args,options={})=>execFileSync('gh',args,{encoding:'utf8',...options});

/** Import a successful run in the same hosted checkout used for staging and publication.
 * Download paths are shared with the publisher, so archives are not fetched twice. */
export async function importVerifiedRun({buildRun,project,version,arch='all',output,directory=root,runGh=runGitHub,
 verifyBundle=verifyRelease,recordBuild=recordGithubBuild}){
 if(!/^[1-9][0-9]{0,19}$/.test(buildRun||'')||!project||!version)throw Error('Select an exact Runtime build run, project and version.');
 if(!path.isAbsolute(output||''))throw Error('Select an absolute publication output directory.');
 const registration=resolveProject(project,directory,{resolvePins:false}),build=buildRecord(registration,version);
 if(build.version!==version||arch!=='all'&&!build.architectures.includes(arch))throw Error('Select a declared package version and architecture.');
 const repository=registration.releaseRepository;
 const run=JSON.parse(await runGh(['run','view',buildRun,'--repo',repository,'--json','workflowName,headSha,headBranch,status,jobs']));
 const targets=(arch==='all'?build.architectures:[arch]).map(arch=>({arch,sourceRevision:verifiedBuildSource(run,{project,version,arch})}));
 const results=[];
 for(const target of targets){
  const download=path.join(output,'downloads',project,version,target.arch);
  fs.mkdirSync(download,{recursive:true});
  await runGh(['run','download',buildRun,'--repo',repository,'--name','runtime-'+[project,version,target.arch].join('-'),'--dir',download]);
  const {record}=await verifyBundle({bundle:download,project,version,arch:target.arch,directory});
  if(record.build?.sourceRevision!==target.sourceRevision||String(record.build?.runId)!==buildRun)throw Error('The downloaded package names a different source or build run.');
  await recordBuild({archive:path.join(download,record.asset.filename),record,directory,
   runGh:(command,args,options)=>{if(command!=='gh')throw Error('Unexpected attestation transport.');return runGh(args,options);}});
  const ledger=path.join(output,'staged-ledgers');fs.mkdirSync(ledger,{recursive:true});
  fs.copyFileSync(path.join(directory,'attestations',record.asset.sha256+'.json'),path.join(ledger,record.asset.sha256+'.json'));
  results.push({project,version,arch:target.arch,sourceRevision:target.sourceRevision,sha256:record.asset.sha256});
  fs.writeFileSync(path.join(output,'imported-builds.json'),JSON.stringify(results,null,2)+'\n');
 }
 return results;
}

/** Publish imported, signed outputs directly from their original GitHub artifacts. */
export async function publishVerified({output,dryRun=false,buildRun,project,version,arch='all',directory=root,runGh=runGitHub}){
 if(!path.isAbsolute(output||'')||typeof dryRun!=='boolean')throw Error('Select an absolute output directory and optional --dry-run.');
 directory=fs.realpathSync(directory);output=path.resolve(output);
 if(output===directory||output.startsWith(directory+path.sep)||directory.startsWith(output+path.sep))throw Error('Keep publication output outside the source checkout.');
 if(buildRun)await importVerifiedRun({buildRun,project,version,arch,output,directory,runGh});
 else if(project||version||arch!=='all')throw Error('Project, version and architecture selection requires --build-run.');
 const coverage=buildCoverage(directory),rows=coverage.githubBuilds.filter(row=>row.projectState==='active'&&!row.catalogPublished);
 fs.mkdirSync(output,{recursive:true});
 const plan={repository:coverage.repository,dryRun,packages:rows.map(({record,sourceRevision,runId,runAttempt})=>({record,sourceRevision,runId,runAttempt}))};
 fs.writeFileSync(path.join(output,'publication-plan.json'),JSON.stringify(plan,null,2)+'\n');
 const results=[];
 for(const row of rows){
  const {record}=row,key=[record.id,record.version,record.arch].join('/'),download=path.join(output,'downloads',record.id,record.version,record.arch),bundle=path.join(output,'bundles',record.id,record.version,record.arch);
  try{
   fs.mkdirSync(download,{recursive:true});
   const archive=path.join(download,record.asset.filename);
   if(!fs.existsSync(archive)){
    try{await runGh(['run','download',row.runId,'--repo',coverage.repository,'--name','runtime-'+[record.id,record.version,record.arch].join('-'),'--dir',download]);}
    catch(error){
     // A retry may outlive its build artifact after the release was created.
     // The same imported signature and archive checks apply to released bytes.
     try{await runGh(['release','download',releaseTag(record),'--repo',coverage.repository,'--pattern',record.asset.filename,'--dir',download]);}
     catch(releasedError){throw Error('The build artifact and existing release archive are unavailable.',{cause:new AggregateError([error,releasedError])});}
    }
   }
   // Cached bytes and newly downloaded artifacts use the same signed identity.
   requireGithubBuild({record,repository:coverage.repository,directory,archive});
   await prepareRelease({project:record.id,archive,record,output:bundle,directory});
   await verifyRelease({bundle,directory});
   if(!dryRun){
    const options={bundle,directory,runGh};
    await stageRelease({...options,target:row.sourceRevision,resume:true});
    await verifyRemoteRelease(options);
    await publishRelease(options);
    await verifyRemoteRelease({...options,requirePublic:true});
    await applyRelease(options);
   }
   results.push({project:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256,sourceRevision:row.sourceRevision,runId:row.runId,bundle,published:!dryRun});
   console.log(JSON.stringify(results.at(-1)));
  }catch(error){throw Error('Verified publication stopped at '+key+': '+error.message,{cause:error});}
 }
 const result={dryRun,selected:rows.length,published:dryRun?0:results.length,results};
 fs.writeFileSync(path.join(output,'publication-result.json'),JSON.stringify(result,null,2)+'\n');
 return result;
}

export function main(args,{env=process.env,...options}={}){
 if(env.GITHUB_ACTIONS!=='true')throw Error('Verified batches are published only by the Runtime release workflow on GitHub.');
 const selected={};for(let i=0;i<args.length;i++){
  const key=args[i];
  if(key==='--dry-run'){if(Object.hasOwn(selected,'dryRun'))throw Error('Use --dry-run only once.');selected.dryRun=true;}
  else if(['--output','--build-run','--project','--version','--arch'].includes(key)&&args[i+1]){
   const name=key==='--build-run'?'buildRun':key.slice(2);if(Object.hasOwn(selected,name))throw Error('Duplicate '+key+'.');selected[name]=args[++i];
  }else throw Error('Use --output /absolute/path, optional --dry-run, or --build-run with --project, --version and optional --arch.');
 }
 return publishVerified({...selected,...options});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify({dryRun:value.dryRun,selected:value.selected,published:value.published}))).catch(error=>{console.error(error);process.exitCode=1;});
