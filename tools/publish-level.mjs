import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {downloadFile,retryNetworkAsync} from './download.mjs';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readProjects} from '../lib/projects.mjs';
import {parseSelection} from './release-selection.mjs';
import {publishPackage,appendPackageCatalog} from './publish-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
const github=async(args)=>retryNetworkAsync(async()=>(await exec('gh',args,{encoding:'utf8',maxBuffer:Infinity})).stdout);
async function downloadArtifact({artifact,bundle,repository,env}){
 const zip=bundle+'.zip';
 try{
  await downloadFile('https://api.github.com/repos/'+repository+'/actions/artifacts/'+artifact.id+'/zip',zip,{environment:env,headers:{Authorization:'Bearer '+(env.GH_TOKEN||env.GITHUB_TOKEN)}});
  const names=execFileSync('unzip',['-Z1',zip],{maxBuffer:Infinity,encoding:'utf8'}).trim().split('\n');
  if(new Set(names).size!==names.length||names.some(name=>path.basename(name)!==name||name==='.'||name==='..'))throw Error('The package artifact has unsafe members.');
  for(const name of names){const fd=fs.openSync(path.join(bundle,name),'wx',0o644);try{execFileSync('unzip',['-p',zip,name],{maxBuffer:Infinity,stdio:['ignore',fd,'pipe']});}finally{fs.closeSync(fd);}}
 }finally{fs.rmSync(zip,{force:true});}
}
/** A clean publisher handles only its completed build level. Other levels and
 * components neither grant upstream code write access nor gate these releases. */
export async function publishLevel({targets,output,directory=root,env=process.env,runGh=github,publish=publishPackage,append=appendPackageCatalog,download=downloadArtifact}={}){
 const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==repository||env.GITHUB_WORKFLOW!=='Build and release'||env.GITHUB_WORKFLOW_REF!==repository+'/.github/workflows/runtime-build.yml@refs/heads/main'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID||''))throw Error('Publication requires the current hosted Build and release run.');
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Publication needs a new absolute work directory.');
 targets??=JSON.parse(env.PUBLICATION_TARGETS||'{}').include;
 if(!Array.isArray(targets)||!targets.length)throw Error('A publisher needs its exact planned level targets.');
 const selection=parseSelection(env.RELEASE_SELECTION),seen=new Set();
 for(const target of targets){const key=[target.project,target.version,target.arch].join('/');if(seen.has(key)||!selection.some(row=>row.id===target.project&&row.version===target.version))throw Error('Publication target differs from the selection.');seen.add(key);}
 const runId=env.GITHUB_RUN_ID;
 const pages=JSON.parse(await runGh(['api','--paginate','--slurp','repos/'+repository+'/actions/runs/'+runId+'/artifacts?per_page=100']));
 const artifacts=pages.flatMap(page=>page.artifacts).filter(artifact=>!artifact.expired);
 fs.mkdirSync(output,{recursive:true});const results=[],errors=[],skipped=[];
 for(const target of targets){try{
  const name='runtime-'+[target.project,target.version,target.arch].join('-');
  const artifact=artifacts.filter(row=>row.name===name||row.name.startsWith(name+'-')&&/^\d+$/.test(row.name.slice(name.length+1))).sort((a,b)=>b.id-a.id)[0];
  if(!artifact){const notice='build of '+[target.project,target.version,target.arch].join(' ')+' in this run produced no package; see its build job';console.log('::notice::'+notice);skipped.push({...target,notice});continue;}
  const bundle=path.join(output,target.project,target.version,target.arch);fs.mkdirSync(bundle,{recursive:true});
  await download({artifact,bundle,repository,env});
  const result=await publish({bundle,directory,env:{...env,BUILD_PROJECT:target.project,BUILD_VERSION:target.version,BUILD_ARCH:target.arch},runGh,append});(result.skipped?skipped:results).push({...target,...result});
 }catch(error){errors.push({...target,error:error.message});}}
 const result={selected:targets.length,published:results.length,failed:errors.length,skipped:skipped.length,results,errors,notices:skipped};fs.writeFileSync(path.join(output,'publication-result.json'),JSON.stringify(result,null,2)+'\n');
 if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'\nPublication outcomes\n'+[
  ...results.map(row=>'- '+[row.project,row.version,row.arch].join(' ')+': published https://github.com/'+repository+'/releases/tag/'+encodeURIComponent(row.project+'/v'+row.version+'/'+row.arch)),
  ...skipped.map(row=>'- '+[row.project,row.version,row.arch].join(' ')+': skipped — '+row.notice),
  ...errors.map(row=>'- '+[row.project,row.version,row.arch].join(' ')+': failed — '+row.error)
 ].join('\n')+'\n');
 return result;
}
export async function main(args,options={}){if(args.length!==2||args[0]!=='--output')throw Error('Use --output /absolute/work-directory.');return publishLevel({...options,output:args[1]});}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
