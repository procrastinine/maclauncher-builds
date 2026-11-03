import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readProjects} from '../lib/projects.mjs';
import {parseSelection} from './release-selection.mjs';
import {publishPackage,appendPackageCatalog} from './publish-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
const github=async(args)=>(await exec('gh',args,{encoding:'utf8',maxBuffer:32<<20})).stdout;
/** A clean publisher handles only its completed build level. Other levels and
 * components neither grant upstream code write access nor gate these releases. */
export async function publishLevel({targets,output,directory=root,env=process.env,runGh=github,publish=publishPackage,append=appendPackageCatalog}={}){
 const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==repository||env.GITHUB_WORKFLOW!=='Build and release'||env.GITHUB_WORKFLOW_REF!==repository+'/.github/workflows/runtime-build.yml@refs/heads/main'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID||''))throw Error('Publication requires the current hosted Build and release run.');
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Publication needs a new absolute work directory.');
 targets??=JSON.parse(env.PUBLICATION_TARGETS||'{}').include;
 if(!Array.isArray(targets)||!targets.length)throw Error('A publisher needs its exact planned level targets.');
 const selection=parseSelection(env.RELEASE_SELECTION),seen=new Set();
 for(const target of targets){const key=[target.project,target.version,target.arch].join('/');if(seen.has(key)||!selection.some(row=>row.id===target.project&&row.version===target.version))throw Error('Publication target differs from the selection.');seen.add(key);}
 const runId=env.GITHUB_RUN_ID;
 fs.mkdirSync(output,{recursive:true});const results=[],errors=[],skipped=[];
 for(const target of targets){try{
  const bundle=path.join(output,target.project,target.version,target.arch);fs.mkdirSync(bundle,{recursive:true});
  try{await runGh(['run','download',runId,'--repo',repository,'--name','runtime-'+[target.project,target.version,target.arch].join('-'),'--dir',bundle]);}
  catch(error){
   if(!/no artifacts match any of the names or patterns specified|no valid artifacts found to download/i.test(String(error.stderr||error.message)))throw error;
   const notice='build of '+[target.project,target.version,target.arch].join(' ')+' in this run produced no package; see its build job';
   console.log('::notice::'+notice);skipped.push({...target,notice});continue;
  }
  const result=await publish({bundle,directory,env:{...env,BUILD_PROJECT:target.project,BUILD_VERSION:target.version,BUILD_ARCH:target.arch},runGh,append});(result.skipped?skipped:results).push({...target,...result});
 }catch(error){errors.push({...target,error:error.message});}}
 const result={selected:targets.length,published:results.length,failed:errors.length,skipped:skipped.length,results,errors,notices:skipped};fs.writeFileSync(path.join(output,'publication-result.json'),JSON.stringify(result,null,2)+'\n');
 if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'\nPublished '+result.published+'/'+result.selected+' packages in this level.\n'+skipped.map(row=>'- '+row.notice).join('\n')+'\n'+errors.map(row=>'- '+row.project+' '+row.version+' '+row.arch+': '+row.error).join('\n')+'\n');
 return result;
}
export async function main(args,options={}){if(args.length!==2||args[0]!=='--output')throw Error('Use --output /absolute/work-directory.');return publishLevel({...options,output:args[1]});}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
