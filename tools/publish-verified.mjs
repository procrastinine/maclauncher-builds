import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildCoverage,requireGithubBuild} from './build-coverage.mjs';
import {releaseTag} from '../lib/project-identity.mjs';
import {prepareRelease,verifyRelease,stageRelease,verifyRemoteRelease,publishRelease,applyRelease} from './release-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const runGitHub=(args,options={})=>execFileSync('gh',args,{encoding:'utf8',...options});

/** Publish imported, signed outputs directly from their original GitHub artifacts. */
export async function publishVerified({output,dryRun=false,directory=root,runGh=runGitHub}){
 if(!path.isAbsolute(output||'')||typeof dryRun!=='boolean')throw Error('Select an absolute output directory and optional --dry-run.');
 directory=fs.realpathSync(directory);output=path.resolve(output);
 if(output===directory||output.startsWith(directory+path.sep)||directory.startsWith(output+path.sep))throw Error('Keep publication output outside the source checkout.');
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

export function main(args,options={}){
 const selected={};for(let i=0;i<args.length;i++){
  const key=args[i];
  if(key==='--dry-run'){if(Object.hasOwn(selected,'dryRun'))throw Error('Use --dry-run only once.');selected.dryRun=true;}
  else if(key==='--output'&&args[i+1]&&!Object.hasOwn(selected,'output'))selected.output=args[++i];
  else throw Error('Use --output /absolute/path and optional --dry-run.');
 }
 return publishVerified({...selected,...options});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify({dryRun:value.dryRun,selected:value.selected,published:value.published}))).catch(error=>{console.error(error);process.exitCode=1;});
