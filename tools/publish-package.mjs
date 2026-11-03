import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {readProjects,resolveProject,buildRecords} from '../lib/projects.mjs';
import {parseSelection,registerSelection} from './release-selection.mjs';
import {recordFromDeclaration,stageRelease,publishRelease,applyRelease} from './release-runtime.mjs';
import {releaseTag} from '../lib/project-identity.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const identity={GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
const git=async(args,{cwd,env=process.env}={})=>(await exec('git',args,{cwd,env:{...env,...identity},maxBuffer:16<<20})).stdout.trim();
const github=async(args,options={})=>(await exec('gh',args,{encoding:'utf8',maxBuffer:32<<20,...options})).stdout;
const archiveEntry=async(archive,name,maxBytes)=>(await exec('tar',['-xzOf',archive,name],{encoding:'buffer',maxBuffer:maxBytes})).stdout;
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
async function sha256File(file){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
/** The build job verified every archived file and its declaration. Publication checks only that this archive and its record are that sealed package. */
export async function sealedBundle({bundle,directory=root}){
 const names=fs.readdirSync(bundle),sidecar=names.find(name=>name.endsWith('.tar.gz.json'));
 if(names.length!==2||!sidecar)throw Error('Select a directory containing exactly one runtime archive and its package record.');
 const record=json(path.join(bundle,sidecar)),{filename,sha256,bytes}=record.asset,archive=path.join(bundle,filename);
 if(sidecar!==filename+'.json'||fs.statSync(archive).size!==bytes||await sha256File(archive)!==sha256)throw Error('Release asset checksum or size changed.');
 const declaration=JSON.parse(await archiveEntry(archive,'runtime-package.json',Infinity));
 if(stable(recordFromDeclaration(declaration,{filename,sha256,bytes},record.sourceAsset,record.source,record))!==stable(record))throw Error('Release record differs from the sealed runtime archive.');
 return {record,declaration,release:{repository:resolveProject(record.id,directory,{resolvePins:false}).releaseRepository,id:record.id,version:record.version,arch:record.arch,tag:releaseTag(record)}};
}
function hosted(env,directory){
 const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==repository||env.GITHUB_WORKFLOW!=='Build and release'||env.GITHUB_WORKFLOW_REF!==repository+'/.github/workflows/runtime-build.yml@refs/heads/main'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID||''))throw Error('Publication requires the current hosted Build and release job on main.');
 return repository;
}
/** Reapply one verified entry to fresh main after a competing normal push.
 * No shared JSON is textually rebased and no remote ref is forced. */
export async function appendPackageCatalog({bundle,record,publication,checked,directory=root,env=process.env,runGit=git,apply=applyRelease,register=registerSelection,runGh=github,attempts=10}={}){
 await runGh(['auth','setup-git']);
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-catalog-')),checkout=path.join(temporary,'checkout');let added=false;
 try{
  for(let attempt=0;attempt<attempts;attempt++){
   await runGit(['fetch','origin','main'],{cwd:directory,env});const head=await runGit(['rev-parse','FETCH_HEAD'],{cwd:directory,env});
   if(!added){await runGit(['worktree','add','--detach',checkout,head],{cwd:directory,env});added=true;}
   else await runGit(['reset','--hard',head],{cwd:checkout,env});
   const project=resolveProject(record.id,checkout,{resolvePins:false});
   const file=path.join(checkout,'catalogs',record.id+'.json'),published=fs.existsSync(file)&&json(file).packages.some(row=>row.version===record.version&&row.arch===record.arch);
   if(!published&&!buildRecords(project).some(build=>build.version===record.version&&build.architectures.includes(record.arch)))register({selection:[{id:record.id,version:record.version}],directory:checkout});
   await apply({bundle,directory:checkout,runGh,publication,checked});
   await runGit(['add','--update'],{cwd:checkout,env});await runGit(['add','--','catalogs'],{cwd:checkout,env});
   if(!(await runGit(['diff','--cached','--name-only'],{cwd:checkout,env})))return {commit:head,existing:true,attempts:attempt+1};
   await runGit(['commit','-m','Publish '+record.id+' '+record.version+' '+record.arch],{cwd:checkout,env});
   try{await runGit(['push','origin','HEAD:main'],{cwd:checkout,env});return {commit:await runGit(['rev-parse','HEAD'],{cwd:checkout,env}),existing:false,attempts:attempt+1};}
   catch(error){
    if(!/non-fast-forward|fetch first|\[(?:remote )?rejected\]|cannot lock ref|stale info/i.test(String(error.stderr||error.message)))throw error;
    if(attempt+1===attempts)throw Error('Catalog publication exhausted '+attempts+' normal-push attempts.',{cause:error});
    // Rejection is authoritative: refetch and reapply immediately. No visibility polling.
   }
  }
 }finally{
  if(added)await runGit(['worktree','remove','--force',checkout],{cwd:directory,env}).catch(()=>{});
  fs.rmSync(temporary,{recursive:true,force:true});
 }
}
/** The already sealed archive is attested, released, then made discoverable. */
export async function publishPackage({bundle,directory=root,env=process.env,runGh=github,verifyBundle=sealedBundle,stageBundle=stageRelease,publishBundle=publishRelease,append=appendPackageCatalog,wait=sleep,readMember=archiveEntry}={}){
 const repository=hosted(env,directory),project=resolveProject(env.BUILD_PROJECT,directory,{resolvePins:false});
 if(!project.packageProfiles.some(profile=>profile.version===env.BUILD_VERSION))registerSelection({selection:[{id:env.BUILD_PROJECT,version:env.BUILD_VERSION}],directory});
 const sourceRevision=env.GITHUB_SHA,runId=env.GITHUB_RUN_ID;
 const checked=await verifyBundle({bundle,directory}),{record,declaration}=checked;
 if(record.id!==env.BUILD_PROJECT||record.version!==env.BUILD_VERSION||record.arch!==env.BUILD_ARCH||record.build?.sourceRevision!==sourceRevision||String(record.build?.runId)!==runId)throw Error('The sealed package differs from this build job.');
 const reports=env.BUILD_REPORTS?json(env.BUILD_REPORTS):null;
 if(reports&&declaration.files.find(file=>file.path==='build-definition.json')?.sha256!==reports[record.id]?.definitionDigest)throw Error('The sealed build definition differs from the plan.');
 const traceFile=declaration.files.find(file=>file.path==='build-inputs.json');
 if(traceFile){
  // Only the input trace is read back from the verified archive.
  const bytes=await readMember(path.join(bundle,record.asset.filename),'files/build-inputs.json',traceFile.size+1);
  const trace=crypto.createHash('sha256').update(bytes).digest('hex')===traceFile.sha256?JSON.parse(bytes.toString('utf8')):null;
  if(trace?.schemaVersion!==1||!Array.isArray(trace.inputs))throw Error('The sealed build-input report is missing or invalid.');
  for(const input of trace.inputs){
   const tag=releaseTag(input);
   if(input.release!==tag||!/^[a-f0-9]{64}$/.test(input.sha256||''))throw Error('The sealed input release identity is invalid.');
   let release;
   try{release=JSON.parse(await runGh(['api','repos/'+repository+'/releases/tags/'+encodeURIComponent(tag)]));}
   catch(error){if(!/HTTP 404/.test(String(error.stderr||error.message)))throw error;}
   if((!release||release.draft)&&env.RELEASE_SELECTION&&parseSelection(env.RELEASE_SELECTION).some(row=>row.id===input.id&&row.version===input.version)){
    const notice='input '+[input.id,input.version,input.arch].join(' ')+' from this run is not published; see its publish job';
    console.log('::notice::'+notice);return {skipped:true,notice};
   }
   if(release?.tag_name!==tag||release.draft!==false||release.assets?.length!==1||release.assets[0].digest!=='sha256:'+input.sha256)throw Error('Required sealed input is not public with its recorded digest: '+tag);
  }
 }
 for(let attempt=0;;attempt++){
  try{await runGh(['attestation','verify',path.join(bundle,record.asset.filename),'--repo',repository,'--signer-workflow',repository+'/.github/workflows/runtime-build.yml']);break;}
  catch(error){if(attempt===4)throw error;await wait(1000*2**attempt);}
 }
 const options={bundle,directory,runGh,checked},staged=await stageBundle({...options,target:sourceRevision,resume:true});
 const publication=await publishBundle({...options,publication:staged});
 const catalog=await append({bundle,record,publication,checked,directory,env,runGh});
 if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'\nPublished '+record.id+' '+record.version+' '+record.arch+'; catalog commit `'+catalog.commit+'`.\n');
 return {...catalog,project:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256};
}
