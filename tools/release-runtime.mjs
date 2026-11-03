import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack,verify,catalog,publicDeclaration} from './runtime-package.mjs';
import {resolveProject,readProjects} from '../lib/projects.mjs';
import {releaseVersion,buildReleaseVersion} from '../lib/package-version.mjs';
import {buildCoverage,assertBuildCoverage} from './build-coverage.mjs';
import {readPublisherInput,assertPublisherSource} from './publisher-files.mjs';
import {assetName,releaseTag,releaseRecord,validateCatalog,identity} from '../lib/project-identity.mjs';
const require=createRequire(import.meta.url),A=require('../lib/archive.cjs'),B=require('../lib/bundled-native.cjs');
const root=path.resolve(import.meta.dirname,'..');
const json=value=>JSON.stringify(value,null,2)+'\n';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const read=file=>JSON.parse(fs.readFileSync(file));
function regular(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Error('Release assets must be regular files.');return s;}
import {recordFromDeclaration,prepareRelease,verifyRelease} from './release-package.mjs';
export {recordFromDeclaration,prepareRelease,verifyRelease};
export {managerDeclaration} from './manager-declaration.mjs';
function write(file,value){fs.writeFileSync(file,json(value),{flag:'wx'});}
function loadPrevious(project,directory){const file=path.join(directory,'catalogs',project+'.json');return fs.existsSync(file)?read(file):undefined;}
function matchingBuildSource(sourceRevision,{record,directory=root}){
 if(readPublisherInput({project:record.id,directory}))return assertPublisherSource({record,directory,sourceRevision});
 const expected=record.build?.sourceRevision||record.source?.revision;
 if(expected&&expected!==sourceRevision)throw Error('Release source commit differs from the recorded build.');
}

/** A single discoverable listing, generated from the same project catalogs used by the launcher. */
export function catalogIndex(directory=root,{coverage=buildCoverage(directory)}={}){
 const registry=readProjects(directory,{resolvePins:false}),catalogs=path.join(directory,'catalogs');
 assertBuildCoverage(coverage,directory);
 const projects=[];
 for(const p of registry.projects){
  if(p.supersededBy!==undefined)continue;
  const file=path.join(catalogs,p.id+'.json');if(!fs.existsSync(file))continue;
  const original=validateCatalog(JSON.parse(fs.readFileSync(file)),{project:p.id,repository:registry.repository,allowEmpty:true});
  const approved=coverage.catalogPackages.filter(row=>row.projectId===p.id&&row.projectState==='active'&&row.catalogState==='active'&&['github','supplied-publisher'].includes(row.origin));
  const packages=original.packages.filter(record=>approved.some(row=>stable(row.record)===stable(record)));
  if(!packages.length)continue;
  const bytes=Buffer.from(json({...original,packages})),page='https://'+registry.repository.split('/')[0]+'.github.io/'+registry.repository.split('/')[1]+'/';
  const profiles=new Map((p.packageProfiles||[]).map(profile=>[profile.version,profile]));
  projects.push({projectId:p.id,name:p.name,delivery:p.delivery,pageUrl:new URL('#'+p.id,page).href,
   catalog:{url:new URL('catalogs/'+p.id+'.json',page).href,sha256:digest(bytes),bytes:bytes.length},
   releases:packages.map(r=>({version:r.version,arch:r.arch,launcherArchitectures:r.launcherArchitectures,minimumMacOS:r.minimumMacOS,tag:r.tag,asset:r.asset,...(r.dependencies?.length?{dependencies:r.dependencies}:{}),...(r.build?{build:r.build}:{}),pageUrl:new URL('#'+(profiles.get(r.version)?.anchor||p.id),page).href,...(profiles.has(r.version)?{profile:profiles.get(r.version).label,...(profiles.get(r.version).anchor?{anchor:profiles.get(r.version).anchor}:{})}:{})}))});
 }
 return {schemaVersion:1,repository:registry.repository,updatePolicy:'manual',projects:projects.sort((a,b)=>a.projectId.localeCompare(b.projectId)),retiredProjects:coverage.retiredProjects};
}

/** Apply only a public, digest-verified release; older versions cannot be removed or replaced. */
export async function applyRelease({bundle,directory=root,runGh=runGitHub,publication,checked}){
 const {release,record,declaration}=await verifyRemoteRelease({bundle,directory,runGh,publication,requirePublic:true,includeDeclaration:true,checked});
 const declarationFile=path.join(directory,'catalogs','declarations',release.id,release.version,release.arch+'.json');
 if(fs.existsSync(declarationFile)){
  regular(declarationFile);if(stable(read(declarationFile))!==stable(declaration))throw Error('An existing sealed declaration differs from this immutable package.');
 }else{fs.mkdirSync(path.dirname(declarationFile),{recursive:true});write(declarationFile,declaration);}
 const previous=loadPrevious(release.id,directory),file=path.join(directory,'catalogs',release.id+'.json');
 const {writePublicationCatalog}=await import('./catalog-publication.mjs');
 const expected=catalog([record],{project:release.id,repository:release.repository,directory}).packages[0];
 if(!previous?.packages.some(value=>stable(value)===stable(expected)))writePublicationCatalog({records:[record],project:release.id,repository:release.repository,directory,output:file,previous});
 const index=catalogIndex(directory);fs.writeFileSync(path.join(directory,'catalogs','index.json'),json(index));return {projectId:release.id,tag:release.tag,catalog:file,declaration:declarationFile};
}

/** Public releases expose only the runtime binary archive. */
export function publicationAssets(release){return release.assets.filter(a=>a.role==='runtime').map(a=>a.filename);}

/** Reconstruct local verification metadata from a committed catalog and downloaded public assets. */
export async function verifyPublicAssets({project,version,arch,assets,output,directory=root}){
 const registration=resolveProject(project,directory,{resolvePins:false}),snapshot=validateCatalog(loadPrevious(project,directory),{project,repository:registration.releaseRepository});
 const record=snapshot.packages.find(r=>r.version===version&&r.arch===arch);if(!record)throw Error('The selected package is absent from the committed project catalog.');
 const names=[record.asset.filename];
 if(fs.readdirSync(assets).length!==names.length||fs.readdirSync(assets).some(name=>!names.includes(name)))throw Error('Public release attachments must contain only the selected runtime archive.');
 return {record,...await verify({archive:path.join(assets,record.asset.filename),sha256:record.asset.sha256,project,version,arch,includeDeclaration:true})};
}

export function releaseNotes(record,project){
 const source=record.build?.sourceRevision,run=record.build?.runId,repo=project.releaseRepository;
 if(source&&run)return 'Built from ['+source+'](https://github.com/'+repo+'/tree/'+source+') by [build '+run+'](https://github.com/'+repo+'/actions/runs/'+run+').\n\n`gh attestation verify '+record.asset.filename+' --repo '+repo+' --signer-workflow '+repo+'/.github/workflows/runtime-build.yml --deny-self-hosted-runners`\n';
 const lines=['Versioned macOS runtime package for '+record.arch+'.','', '<details>','<summary>Source</summary>',''];
 if(record.source){const s=record.source,base='https://github.com/'+s.repository+'/tree/'+s.revision;lines.push('[Complete source and patches]('+base+(s.path?'/'+s.path:'')+')','', 'The release tag identifies the source commit. Pinned upstream repositories and build recipes are included in that source. GitHub source ZIPs omit submodule contents; recursive Git checkout retains their exact pins.');}
 else lines.push('[Source and patches](https://github.com/'+project.releaseRepository+'/tree/'+encodeURIComponent(releaseTag(record))+')');
 for(const upstream of project.upstreams||[]){const suffix=upstream.provider==='gitiles'?'/+/':upstream.url.includes('gitlab')?'/-/tree/':'/tree/';if(upstream.revision)lines.push('- ['+upstream.id+']('+upstream.url+suffix+upstream.revision+')');}
 lines.push('','</details>');return lines.join('\n');
}

const runGitHub=(args,options={})=>{requireHostedPublication();return execFileSync('gh',args,{encoding:'utf8',...options});};
function missingRef(error){return error.status===404||error.statusCode===404||/\bHTTP 404\b/.test(String(error.stderr||''));}
async function releaseTagCommit(ref,{repository,runGh}){
 const seen=new Set();let object=ref.object;
 while(object?.type==='tag'){
  if(seen.has(object.sha)||seen.size>=10)throw Error('Release tag annotation chain is invalid.');
  seen.add(object.sha);object=JSON.parse(await runGh(['api','repos/'+repository+'/git/tags/'+object.sha])).object;
 }
 if(object?.type!=='commit'||!/^[a-f0-9]{40}$/.test(object.sha))throw Error('Release tag does not identify a source commit.');
 return object.sha;
}
async function optionalGitHub(args,runGh){try{return JSON.parse(await runGh(['api',...args]));}catch(error){if(!missingRef(error))throw error;}}
async function releaseAsset(asset,record,{repository,runGh,uploaded=false}){
 if(!asset||asset.name!==record.asset.filename||asset.size!==record.asset.bytes||asset.state!=='uploaded')throw Error('Existing release asset differs from the selected record.');
 let sha256=asset.digest;
 if(!sha256&&!uploaded){const bytes=await runGh(['api','repos/'+repository+'/releases/assets/'+asset.id,'-H','Accept: application/octet-stream'],{encoding:null});if(bytes.length!==record.asset.bytes)throw Error('Existing release asset size differs from the selected record.');sha256='sha256:'+digest(bytes);}
 if(sha256!=='sha256:'+record.asset.sha256)throw Error('Existing release asset checksum differs from the selected record.');
 return asset;
}
function releaseIdentity(remote,{release,record,sourceCommit}){
 if(!Number.isSafeInteger(remote?.id)||remote.id<=0||remote.tag_name!==release.tag||typeof remote.draft!=='boolean'||!Array.isArray(remote.assets))throw Error('Existing release differs from the selected record.');
 return {repository:release.repository,tag:release.tag,id:remote.id,draft:remote.draft,sourceCommit,sha256:record.asset.sha256};
}
async function publicTagCommit({release,runGh}){
 const ref=await optionalGitHub(['repos/'+release.repository+'/git/ref/tags/'+release.tag],runGh);
 if(!ref)throw Error('Public release tag is missing: '+release.tag);
 return releaseTagCommit(ref,{repository:release.repository,runGh});
}
/** Verify an existing release or the publication returned by this process. */
export async function verifyRemoteRelease({bundle,directory=root,runGh=runGitHub,requirePublic=false,includeDeclaration=false,publication,checked}){
 checked??=await verifyRelease({bundle,directory,includeDeclaration});
 if(publication){if(publication.repository!==checked.release.repository||publication.tag!==checked.release.tag||!Number.isSafeInteger(publication.id)||publication.id<=0||typeof publication.draft!=='boolean'||publication.sha256!==checked.record.asset.sha256)throw Error('Publication identity differs from the verified release.');}
 else{
  const remote=await optionalGitHub(['repos/'+checked.release.repository+'/releases/tags/'+encodeURIComponent(checked.release.tag)],runGh);
  if(!remote)throw Error('The selected release has not been staged.');
  const sourceCommit=await publicTagCommit({...checked,runGh});
  publication=releaseIdentity(remote,{...checked,sourceCommit});
  if(remote.assets.length!==1)throw Error('Existing release differs from the selected record.');
  await releaseAsset(remote.assets[0],checked.record,{repository:checked.release.repository,runGh});
 }
 matchingBuildSource(publication.sourceCommit,{record:checked.record,directory});
 if(requirePublic&&publication.draft!==false)throw Error('Catalog updates require a public, non-draft release.');
 return {...checked,publication};
}
/** An unpublished attempt owns only its draft; the public tag is created by finalization. */
export async function stageRelease({bundle,target,resume=false,directory=root,runGh=runGitHub,checked}){
 if(!/^[a-f0-9]{40}$/.test(target||''))throw Error('Staging requires an exact public source commit through --target.');
 if(typeof resume!=='boolean')throw Error('Staging resume must be a boolean.');
 checked??=await verifyRelease({bundle,directory});const {release,record}=checked,project=resolveProject(release.id,directory,{resolvePins:false});
 matchingBuildSource(target,{record,directory});
 let sourceCommit=target;
 let remote=await optionalGitHub(['repos/'+release.repository+'/releases/tags/'+encodeURIComponent(release.tag)],runGh);
 if(!remote||remote.draft){
  const drafts=resume?JSON.parse(await runGh(['api','--paginate','--slurp','repos/'+release.repository+'/releases?per_page=100'])).flat().filter(row=>row.draft===true&&row.tag_name===release.tag):remote?[remote]:[];
  for(const draft of new Map(drafts.map(row=>[row.id,row])).values()){
   if(!Number.isSafeInteger(draft.id)||draft.id<=0)throw Error('Invalid unfinished release identity.');
   await runGh(['api','--method','DELETE','repos/'+release.repository+'/releases/'+draft.id]);
  }
  remote=undefined;
 }
 let created=false;
 if(!remote){
  remote=JSON.parse(await runGh(['api','--method','POST','repos/'+release.repository+'/releases','-f','tag_name='+release.tag,'-f','target_commitish='+target,'-F','draft=true','-f','make_latest=false','-f','name='+project.name+' '+release.version+' ('+release.arch+')','-f','body='+releaseNotes({...record,source:{repository:release.repository,revision:target}},project)]));created=true;
 }else{sourceCommit=await publicTagCommit({release,runGh});matchingBuildSource(sourceCommit,{record,directory});}
 const publication=releaseIdentity(remote,{release,record,sourceCommit});
 try{
 if(remote.assets.length===0&&remote.draft){
  const uploaded=JSON.parse(await runGh(['api','--method','POST','https://uploads.github.com/repos/'+release.repository+'/releases/'+remote.id+'/assets?name='+encodeURIComponent(record.asset.filename),'-H','Content-Type: application/x-gtar','--input',path.join(path.resolve(bundle),record.asset.filename)]));
  await releaseAsset(uploaded,record,{repository:release.repository,runGh,uploaded:true});
 }else{
  if(remote.assets.length!==1)throw Error('Existing release differs from the selected record.');
  await releaseAsset(remote.assets[0],record,{repository:release.repository,runGh});
 }
 return publication;
 }catch(error){if(created)await runGh(['api','--method','DELETE','repos/'+release.repository+'/releases/'+remote.id]);throw error;}
}
/** Finalize the exact staged REST ID; no tag or releases-list lookup follows upload. */
export async function publishRelease({bundle,directory=root,runGh=runGitHub,publication,wait=sleep,checked}){
 try{
  checked=await verifyRemoteRelease({bundle,directory,runGh,publication,checked});const {release,record}=checked,existing=checked.publication;publication=existing;
  if(!existing.draft)return existing;
  let remote;
  for(let attempt=0;attempt<5;attempt++){
   try{remote=JSON.parse(await runGh(['api','--method','PATCH','repos/'+release.repository+'/releases/'+existing.id,'-F','draft=false','-f','make_latest=false']));break;}
   catch(error){if(attempt===4)throw error;await wait(1000*2**attempt);}
  }
  if(remote.id!==existing.id||remote.tag_name!==release.tag||remote.draft!==false)throw Error('Published release differs from its staged REST identity.');
  return {...existing,draft:false};
 }catch(error){
  if(publication?.draft){
   const current=await optionalGitHub(['repos/'+publication.repository+'/releases/'+publication.id],runGh);
   if(current?.draft===true)await runGh(['api','--method','DELETE','repos/'+publication.repository+'/releases/'+publication.id]);
  }
  throw error;
 }
}

// Packages move from their GitHub run to their release and catalog only inside
// GitHub Actions, so release files never travel through a local copy.
export function requireHostedPublication({env=process.env}={}){
 if(env.GITHUB_ACTIONS!=='true')throw Error('Packages are released only inside Build and release on GitHub.');
}

function options(args){const result={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!args[i+1]||Object.hasOwn(result,key))throw Error('Use unique --option value pairs.');result[key]=args[i+1];}return result;}
export async function main([command,...args],directory=root,env=process.env){
 const o=options(args),allowed={prepare:['project','input','declaration','archive','record','source','source-revision','output'],verify:['bundle','project','version','arch'],'verify-assets':['project','version','arch','assets','output'],index:['output']}[command];
 if(!allowed||Object.keys(o).some(k=>!allowed.includes(k)))throw Error('Use prepare, verify, verify-assets or index with explicit options.');
 if(command==='prepare'){
  if(!o.project||!o.output)throw Error('prepare requires --project and --output.');
  if(o.declaration){let d=read(o.declaration);if(Array.isArray(d)){d=d.filter(item=>item.id===o.project);if(d.length!==1)throw Error('Declaration must select exactly one project.');d=d[0];}o.declaration=d;}
  if(o.record)o.record=read(o.record);const {'source-revision':sourceRevision,...selected}=o;return prepareRelease({...selected,sourceRevision,directory});
 }
 if(command==='verify-assets')return verifyPublicAssets({...o,directory});
 if(command==='verify')return verifyRelease({...o,directory});
 if(command==='index'){if(!o.output)throw Error('index requires --output.');const result=catalogIndex(directory);fs.mkdirSync(path.dirname(o.output),{recursive:true});fs.writeFileSync(o.output,json(result));return result;}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
