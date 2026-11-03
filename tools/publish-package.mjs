import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readProjects,resolveProject,buildRecords} from '../lib/projects.mjs';
import {registerSelection} from './release-selection.mjs';
import {verifyRelease,stageRelease,publishRelease,applyRelease} from './release-runtime.mjs';
import {recordGithubBuild} from './record-github-build.mjs';
import {requireGithubBuild} from './build-coverage.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const identity={GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
const git=async(args,{cwd,env=process.env}={})=>(await exec('git',args,{cwd,env:{...env,...identity},maxBuffer:16<<20})).stdout.trim();
const github=async(args,options={})=>(await exec('gh',args,{encoding:'utf8',maxBuffer:32<<20,...options})).stdout;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function hosted(env,directory){
 const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==repository||env.GITHUB_WORKFLOW!=='Build and release'||env.GITHUB_WORKFLOW_REF!==repository+'/.github/workflows/runtime-build.yml@refs/heads/main'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID||''))throw Error('Publication requires the current hosted Build and release job on main.');
 return repository;
}
/** Reapply one verified entry to fresh main after a competing normal push.
 * No shared JSON is textually rebased and no remote ref is forced. */
export async function appendPackageCatalog({bundle,record,ledger,directory=root,env=process.env,runGit=git,apply=applyRelease,register=registerSelection,runGh=github,sleep=delay,random=Math.random,attempts=10}={}){
 await runGh(['auth','setup-git']);
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-catalog-')),checkout=path.join(temporary,'checkout');let added=false;
 try{
  for(let attempt=0;attempt<attempts;attempt++){
   await runGit(['fetch','origin','main'],{cwd:directory,env});const head=await runGit(['rev-parse','FETCH_HEAD'],{cwd:directory,env});
   if(!added){await runGit(['worktree','add','--detach',checkout,head],{cwd:directory,env});added=true;}
   else await runGit(['reset','--hard',head],{cwd:checkout,env});
   const project=resolveProject(record.id,checkout,{resolvePins:false});
   if(!buildRecords(project).some(build=>build.version===record.version&&build.architectures.includes(record.arch)))register({selection:[{id:record.id,version:record.version}],directory:checkout});
   const destination=path.join(checkout,'attestations',record.asset.sha256+'.json');fs.mkdirSync(path.dirname(destination),{recursive:true});
   if(!fs.existsSync(destination))fs.copyFileSync(ledger,destination);
   await apply({bundle,directory:checkout,runGh});
   await runGit(['add','--update'],{cwd:checkout,env});await runGit(['add','--','catalogs','attestations'],{cwd:checkout,env});
   if(!(await runGit(['diff','--cached','--name-only'],{cwd:checkout,env})))return {commit:head,existing:true,attempts:attempt+1};
   await runGit(['commit','-m','Publish '+record.id+' '+record.version+' '+record.arch],{cwd:checkout,env});
   try{await runGit(['push','origin','HEAD:main'],{cwd:checkout,env});return {commit:await runGit(['rev-parse','HEAD'],{cwd:checkout,env}),existing:false,attempts:attempt+1};}
   catch(error){
    if(!/non-fast-forward|fetch first|\[rejected\]|stale info/i.test(String(error.stderr||error.message)))throw error;
    if(attempt+1===attempts)throw Error('Catalog publication exhausted '+attempts+' normal-push attempts.',{cause:error});
    await sleep(500+Math.floor(random()*2500));
   }
  }
 }finally{
  if(added)await runGit(['worktree','remove','--force',checkout],{cwd:directory,env}).catch(()=>{});
  fs.rmSync(temporary,{recursive:true,force:true});
 }
}
/** The already sealed archive is attested, released, then made discoverable. */
export async function publishPackage({bundle,directory=root,env=process.env,runGh=github,verifyBundle=verifyRelease,recordBuild=recordGithubBuild,requireBuild=requireGithubBuild,stageBundle=stageRelease,publishBundle=publishRelease,append=appendPackageCatalog}={}){
 const repository=hosted(env,directory),project=resolveProject(env.BUILD_PROJECT,directory,{resolvePins:false});
 if(!buildRecords(project).some(build=>build.version===env.BUILD_VERSION&&build.architectures.includes(env.BUILD_ARCH)))registerSelection({selection:[{id:env.BUILD_PROJECT,version:env.BUILD_VERSION}],directory});
 const sourceRevision=env.PUBLICATION_SOURCE_SHA||env.GITHUB_SHA,runId=env.PUBLICATION_RUN_ID||env.GITHUB_RUN_ID;
 const {record,declaration}=await verifyBundle({bundle,directory,includeDeclaration:true});
 if(record.id!==env.BUILD_PROJECT||record.version!==env.BUILD_VERSION||record.arch!==env.BUILD_ARCH||record.build?.sourceRevision!==sourceRevision||String(record.build?.runId)!==runId)throw Error('The sealed package differs from this build job.');
 const reports=env.BUILD_REPORTS?json(env.BUILD_REPORTS):null;
 if(reports&&declaration.files.find(file=>file.path==='build-definition.json')?.sha256!==reports[record.id]?.definitionDigest)throw Error('The sealed build definition differs from the plan.');
 let existing;
 try{existing=JSON.parse(await runGh(['api','repos/'+repository+'/releases/tags/'+encodeURIComponent(record.id+'/v'+record.version+'/'+record.arch)]));}
 catch(error){if(!/HTTP 404|Not Found|release not found/i.test(String(error.stderr||error.message)))throw error;}
 if(existing){const previous=/\/actions\/runs\/([0-9]+)/.exec(existing.body||'')?.[1];if(previous!==runId)throw Error(record.id+' '+record.version+' '+record.arch+' already published by run '+(previous||'unknown')+'.');}
 const archive=path.join(bundle,record.asset.filename);
 await recordBuild({archive,record,directory,runGh:(command,args,options)=>{if(command!=='gh')throw Error('Unexpected attestation transport.');return runGh(args,options);}});
 requireBuild({record,repository,directory,archive,sourceRevision});
 const options={bundle,directory,runGh};await stageBundle({...options,target:sourceRevision,resume:true});await publishBundle(options);
 const catalog=await append({bundle,record,ledger:path.join(directory,'attestations',record.asset.sha256+'.json'),directory,env,runGh});
 if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'\nPublished '+record.id+' '+record.version+' '+record.arch+'; catalog commit `'+catalog.commit+'`.\n');
 return {...catalog,project:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256};
}
export async function main(args,options={}){if(args.length!==2||args[0]!=='--bundle'||!path.isAbsolute(args[1]||''))throw Error('Use --bundle /absolute/release-directory.');return publishPackage({...options,bundle:args[1]});}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
