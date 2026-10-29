import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack,verify,catalog,publicDeclaration} from './runtime-package.mjs';
import {resolveProject,readProjects} from '../lib/projects.mjs';
import {releaseVersion} from '../lib/package-version.mjs';
import {assetName,releaseTag,releaseRecord,validateCatalog,identity} from '../lib/project-identity.mjs';
const require=createRequire(import.meta.url),A=require('../lib/archive.cjs'),B=require('../lib/bundled-native.cjs');
const root=path.resolve(import.meta.dirname,'..');
const json=value=>JSON.stringify(value,null,2)+'\n';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const read=file=>JSON.parse(fs.readFileSync(file));
function regular(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Error('Release assets must be regular files.');return s;}
function copy(input,output){regular(input);fs.copyFileSync(input,output,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);}
function sourceRecord(d,repo){if(!d.sourceArtifact)return undefined;const source=d.sourceArtifact,filename=path.posix.basename(source.directoryRelative);return {filename,url:'https://github.com/'+repo+'/releases/download/'+encodeURIComponent(releaseTag(d))+'/'+filename,sha256:source.sha256,bytes:source.bytes};}
function recordFromDeclaration(d,asset,sourceAsset,source,catalogRecord={}){
 // Catalog metadata is validated by releaseRecord before this reconstruction.
 // Sealed declaration and archive facts always replace catalog payload fields.
 const {tag,asset:catalogAsset,source:catalogSource,sourceAsset:catalogSourceAsset,...metadata}=catalogRecord;
 return {...metadata,schemaVersion:2,id:d.id,version:d.version,arch:d.arch,launcherArchitectures:d.launcherArchitectures,minimumMacOS:d.minimumMacOS,manifestRelative:d.manifestRelative,manifestSha256:d.manifestSha256,sourceSha256:d.sourceSha256,updatePolicy:'manual',asset,...(sourceAsset?{sourceAsset}:{}),...(source?{source}:{})};
}
async function asset(directory,name,role){const file=path.join(directory,name);return {filename:name,role,sha256:await A.checksum(file),bytes:regular(file).size};}
function write(file,value){fs.writeFileSync(file,json(value),{flag:'wx'});}
function loadPrevious(project,directory){const file=path.join(directory,'catalogs',project+'.json');return fs.existsSync(file)?read(file):undefined;}

/** Adapt an existing sealed manager output without changing its files or manifest. */
export async function managerDeclaration({project,input,source}){
 const file=path.join(input,'manifest.json'),bytes=fs.readFileSync(file),m=B.validateManifest(JSON.parse(bytes),{managerId:project});B.verifyPayload(path.join(input,'files'),m);
 const manifestSha256=digest(bytes),launcherArchitectures=m.arch==='x64'?['arm64','x64']:['arm64'];
 const files=m.files.map(f=>({...f,path:'files/'+f.path,...(m.arch==='x64'&&f.architectures?{executionArchitecture:'x86_64'}:{})}));
 files.push({path:'manifest.json',size:bytes.length,mode:regular(file).mode&0o777,sha256:manifestSha256});
 let sourceArtifact;if(source){sourceArtifact={directoryRelative:project+'/'+m.version+'-source.tar.gz',sha256:await A.checksum(source),bytes:regular(source).size};}
 return publicDeclaration({id:project,version:m.version,arch:m.arch,launcherArchitectures,minimumMacOS:m.minimumMacOS,directoryRelative:project+'/'+m.version+'/'+m.arch,manifestRelative:'manifest.json',manifestSha256,sourceSha256:sourceArtifact?.sha256||manifestSha256,...(sourceArtifact?{sourceArtifact}:{sourceRelative:'manifest.json'}),files,notices:m.notices.map(n=>({...n,path:'files/'+n.path})),redistribution:'bundle'});
}

/** Prepare one release from sealed files or an already packed archive. No build or network call occurs. */
export async function prepareRelease({project,input,declaration,archive,record,source,sourceRevision,output,directory=root}){
 const registration=resolveProject(project,directory,{resolvePins:false}),repo=registration.releaseRepository;
 const legacySourceAsset=record?.sourceAsset;
 const sourcePointer=record?.source||(sourceRevision?{repository:repo,revision:sourceRevision}:registration.producer.source);
 if(!output)throw Error('Choose a release output directory.');
 if(fs.existsSync(output)){
  if(!archive||!record)throw Error('Choose a new release output directory.');
  const existing=await verifyRelease({bundle:output,directory});
  releaseRecord(record,{project,repository:repo});
  if(stable(catalog([record],{project,repository:repo}).packages[0])!==stable(catalog([existing.record],{project,repository:repo}).packages[0])||regular(archive).size!==record.asset.bytes||await A.checksum(archive)!==record.asset.sha256)throw Error('Existing release output differs from the selected record.');
  return {...existing.release,existing:true};
 }
 if(archive?(!record||input||declaration):(!input||record))throw Error('Select sealed --input and --declaration, or existing --archive and --record.');
 if(!archive){declaration??=await managerDeclaration({project,input,source});declaration=publicDeclaration(declaration);if(declaration.id!==project)throw Error('Declaration belongs to another project.');}
 else releaseRecord(record,{project,repository:repo});
 const selected=archive?record:declaration;
 releaseVersion(project,selected.version,directory);
 const previous=loadPrevious(project,directory);
 const parent=path.dirname(path.resolve(output));fs.mkdirSync(parent,{recursive:true});
 const staging=fs.mkdtempSync(path.join(parent,'.release-'));
 try{
  const name=assetName(selected),archivePath=path.join(staging,name);
  if(archive){copy(archive,archivePath);const checked=await verify({archive:archivePath,sha256:record.asset.sha256,project,version:record.version,arch:record.arch,includeDeclaration:true});declaration=checked.declaration;
   const expected=recordFromDeclaration(declaration,{filename:name,sha256:record.asset.sha256,bytes:regular(archivePath).size},undefined,undefined,record);
   if(stable({...record,tag:undefined,sourceAsset:undefined,source:undefined,asset:{...record.asset,url:undefined}})!==stable(expected))throw Error('Release record differs from the sealed runtime archive.');
   record=expected;write(archivePath+'.json',record);
  }else record=await pack({project,input,declaration,output:archivePath});
  if(sourcePointer)record.source=sourcePointer;
  if(legacySourceAsset)record.sourceAsset=legacySourceAsset;
  fs.writeFileSync(archivePath+'.json',json(record));
  const next=catalog([record],{project,repository:repo,previous});
  write(path.join(staging,project+'.json'),next);
  if(declaration.sourceArtifact&&source){
   const expected=declaration.sourceArtifact;
   if(regular(source).size!==expected.bytes||await A.checksum(source)!==expected.sha256)throw Error('Corresponding-source archive differs from its sealed identity.');
   const sourceName=path.posix.basename(expected.directoryRelative);copy(source,path.join(staging,sourceName));
  }else if(source)throw Error('The declaration already includes its corresponding sources.');
  const checked=await verifyRelease({bundle:staging,directory});fs.renameSync(staging,path.resolve(output));return checked.release;
 }finally{fs.rmSync(staging,{recursive:true,force:true});}
}

/** Verify downloaded release assets without executing runtime contents. */
export async function verifyRelease({bundle,project,version,arch,directory=root}){
 const sidecars=fs.readdirSync(bundle).filter(name=>name.endsWith('.tar.gz.json'));if(sidecars.length!==1)throw Error('Select a directory containing exactly one runtime archive and its package record.');
 const record=read(path.join(bundle,sidecars[0]));identity(record);const registration=resolveProject(record.id,directory,{resolvePins:false}),repo=registration.releaseRepository;releaseRecord(record,{project:record.id,repository:repo});
 if(project&&record.id!==project||version&&record.version!==version||arch&&record.arch!==arch)throw Error('Release metadata differs from the selected project, version or architecture.');
 releaseVersion(record.id,record.version,directory);
 const name=assetName(record);if(sidecars[0]!==name+'.json')throw Error('Release asset belongs to a different project or version.');
 const runtime=path.join(bundle,name);if(regular(runtime).size!==record.asset.bytes)throw Error('Release asset checksum or size changed.');
 const checked=await verify({archive:runtime,sha256:record.asset.sha256,project:record.id,version:record.version,arch:record.arch,includeDeclaration:true});
 const expected=recordFromDeclaration(checked.declaration,{filename:name,sha256:record.asset.sha256,bytes:record.asset.bytes},record.sourceAsset,record.source,record);
 if(stable(record)!==stable(expected))throw Error('Release record differs from the sealed runtime archive.');
 const snapshot=validateCatalog(read(path.join(bundle,record.id+'.json')),{project:record.id,repository:repo}),next=catalog([record],{project:record.id,repository:repo});
 if(stable(snapshot.packages.find(p=>p.version===record.version&&p.arch===record.arch))!==stable(next.packages[0]))throw Error('Release catalog does not contain the selected package.');
 const required=checked.declaration.sourceArtifact,sourceName=required&&path.posix.basename(required.directoryRelative),source=sourceName&&path.join(bundle,sourceName),hasSource=Boolean(source&&fs.existsSync(source));
 if(record.sourceAsset&&stable(record.sourceAsset)!==stable(sourceRecord(checked.declaration,repo)))throw Error('Release source asset differs from the sealed source identity.');
 if(hasSource&&(regular(source).size!==required.bytes||await A.checksum(source)!==required.sha256))throw Error('Release asset checksum or size changed.');
 const names=[name,name+'.json',record.id+'.json',...(hasSource?[sourceName]:[])];if(fs.readdirSync(bundle).some(name=>!names.includes(name)))throw Error('Release directory contains undeclared files.');
 const assets=[await asset(bundle,name,'runtime'),await asset(bundle,name+'.json','record'),await asset(bundle,record.id+'.json','catalog'),...(hasSource?[await asset(bundle,sourceName,'source')]:[])];
 return {release:{schemaVersion:1,repository:repo,id:record.id,version:record.version,arch:record.arch,tag:releaseTag(record),assets},record,catalog:snapshot};
}

/** A single discoverable listing, generated from the same project catalogs used by the launcher. */
export function catalogIndex(directory=root){
 const registry=readProjects(directory,{resolvePins:false}),catalogs=path.join(directory,'catalogs');
 const projects=[];
 for(const p of registry.projects){const file=path.join(catalogs,p.id+'.json');if(!fs.existsSync(file))continue;const bytes=fs.readFileSync(file),c=validateCatalog(JSON.parse(bytes),{project:p.id,repository:registry.repository,allowEmpty:true});if(!c.packages.length)continue;
  const page='https://'+registry.repository.split('/')[0]+'.github.io/'+registry.repository.split('/')[1]+'/';
  const profiles=new Map((p.packageProfiles||[]).map(profile=>[profile.version,profile]));
  projects.push({projectId:p.id,name:p.name,delivery:p.delivery,pageUrl:new URL('#'+p.id,page).href,catalog:{url:'https://raw.githubusercontent.com/'+registry.repository+'/main/catalogs/'+p.id+'.json',sha256:digest(bytes),bytes:bytes.length},releases:c.packages.map(r=>({version:r.version,arch:r.arch,minimumMacOS:r.minimumMacOS,tag:r.tag,asset:r.asset,pageUrl:new URL('#'+(profiles.get(r.version)?.anchor||p.id),page).href,...(profiles.has(r.version)?{profile:profiles.get(r.version).label,...(profiles.get(r.version).anchor?{anchor:profiles.get(r.version).anchor}:{})}:{})}))});
 }
 return {schemaVersion:1,repository:registry.repository,updatePolicy:'manual',projects:projects.sort((a,b)=>a.projectId.localeCompare(b.projectId))};
}

/** Apply only a public, digest-verified release; older versions cannot be removed or replaced. */
export async function applyRelease({bundle,directory=root,runGh=runGitHub}){
 const {release,record}=await verifyRemoteRelease({bundle,directory,runGh,requirePublic:true});
 const previous=loadPrevious(release.id,directory),next=catalog([record],{project:release.id,repository:release.repository,previous});
 const file=path.join(directory,'catalogs',release.id+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 const temporary=file+'.tmp-'+process.pid;try{fs.writeFileSync(temporary,json(next),{flag:'wx'});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
 const index=catalogIndex(directory);fs.writeFileSync(path.join(directory,'catalogs','index.json'),json(index));return {projectId:release.id,tag:release.tag,catalog:file};
}

/** Public releases expose only the runtime binary archive. */
export function publicationAssets(release){return release.assets.filter(a=>a.role==='runtime').map(a=>a.filename);}

/** Reconstruct local verification metadata from a committed catalog and downloaded public assets. */
export async function verifyPublicAssets({project,version,arch,assets,output,directory=root}){
 const registration=resolveProject(project,directory,{resolvePins:false}),snapshot=validateCatalog(loadPrevious(project,directory),{project,repository:registration.releaseRepository});
 const record=snapshot.packages.find(r=>r.version===version&&r.arch===arch);if(!record)throw Error('The selected package is absent from the committed project catalog.');
 const names=[record.asset.filename];
 if(fs.readdirSync(assets).length!==names.length||fs.readdirSync(assets).some(name=>!names.includes(name)))throw Error('Public release attachments must contain only the selected runtime archive.');
 return prepareRelease({project,archive:path.join(assets,record.asset.filename),record,output,directory});
}

export function releaseNotes(record,project){
 const lines=['Versioned macOS runtime package for '+record.arch+'.','', '<details>','<summary>Source</summary>',''];
 if(record.source){const s=record.source,base='https://github.com/'+s.repository+'/tree/'+s.revision;lines.push('[Complete source and patches]('+base+(s.path?'/'+s.path:'')+')','', 'The release tag identifies the source commit. Pinned upstream repositories and build recipes are included in that source. GitHub source ZIPs omit submodule contents; recursive Git checkout retains their exact pins.');}
 else lines.push('[Source and patches](https://github.com/'+project.releaseRepository+'/tree/'+encodeURIComponent(releaseTag(record))+')');
 for(const upstream of project.upstreams||[]){const suffix=upstream.provider==='gitiles'?'/+/':upstream.url.includes('gitlab')?'/-/tree/':'/tree/';if(upstream.revision)lines.push('- ['+upstream.id+']('+upstream.url+suffix+upstream.revision+')');}
 lines.push('','</details>');return lines.join('\n');
}

const runGitHub=(args,options={})=>execFileSync('gh',args,{encoding:'utf8',...options});
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
/** Existing tags, releases and assets are immutable; matching assets are a no-op. */
async function existingRelease({release,record,runGh}){
 const repository=release.repository,tag=release.tag;
 const ref=await optionalGitHub(['repos/'+repository+'/git/ref/tags/'+tag],runGh);
 const commit=ref&&await releaseTagCommit(ref,{repository,runGh});
 const pages=JSON.parse(await runGh(['api','--paginate','--slurp','repos/'+repository+'/releases?per_page=100']));
 const matches=pages.flat().filter(row=>row.tag_name===tag);
 if(matches.length>1)throw Error('Existing release identity is ambiguous.');
 const remote=matches[0];
 if(!ref&&!remote)return;
 if(!ref||!remote)throw Error('Existing release identity is incomplete; no tag or asset will be replaced.');
 if(remote.tag_name!==tag||remote.assets?.length!==1)throw Error('Existing release differs from the selected record.');
 const asset=remote.assets[0];
 if(asset.name!==record.asset.filename||asset.size!==record.asset.bytes||asset.state!=='uploaded')throw Error('Existing release asset differs from the selected record.');
 let sha256=asset.digest;
 if(!sha256){const bytes=await runGh(['api','repos/'+repository+'/releases/assets/'+asset.id,'-H','Accept: application/octet-stream'],{encoding:null});if(bytes.length!==record.asset.bytes)throw Error('Existing release asset size differs from the selected record.');sha256='sha256:'+digest(bytes);}
 if(sha256!=='sha256:'+record.asset.sha256)throw Error('Existing release asset checksum differs from the selected record.');
 return {repository,tag,draft:remote.draft,existing:true,sourceCommit:commit,sha256:record.asset.sha256};
}

/** Verify the immutable remote asset, including staged drafts, without changing GitHub. */
export async function verifyRemoteRelease({bundle,directory=root,runGh=runGitHub,requirePublic=false}){
 const checked=await verifyRelease({bundle,directory});
 const publication=await existingRelease({...checked,runGh});
 if(!publication)throw Error('The selected release has not been staged.');
 if(requirePublic&&publication.draft!==false)throw Error('Catalog updates require a public, non-draft release.');
 return {...checked,publication};
}

/** Explicit network action: upload only a release with no existing public identity. */
export async function stageRelease({bundle,target,directory=root,runGh=runGitHub}){
 if(!/^[a-f0-9]{40}$/.test(target||''))throw Error('Staging requires an exact public source commit through --target.');
 const {release,record}=await verifyRelease({bundle,directory}),project=resolveProject(release.id,directory);
 const existing=await existingRelease({release,record,runGh});if(existing)return existing;
 const ref=JSON.parse(await runGh(['api','--method','POST','repos/'+release.repository+'/git/refs','-f','ref=refs/tags/'+release.tag,'-f','sha='+target]));
 if(await releaseTagCommit(ref,{repository:release.repository,runGh})!==target)throw Error('Release tag differs from the exact source commit.');
 const files=publicationAssets(release).map(name=>path.join(path.resolve(bundle),name));
 await runGh(['release','create',release.tag,'--repo',release.repository,'--draft','--verify-tag','--latest=false','--target',target,'--title',project.name+' '+release.version+' ('+release.arch+')','--notes',releaseNotes({...record,source:{repository:release.repository,revision:target}},project),...files],{stdio:'inherit'});
 return {repository:release.repository,tag:release.tag,draft:true};
}

/** Publishing finalizes a verified draft; an already public release is unchanged. */
export async function publishRelease({bundle,directory=root,runGh=runGitHub}){
 const {release,record}=await verifyRelease({bundle,directory});
 const existing=await existingRelease({release,record,runGh});
 if(!existing)throw Error('The selected release has not been staged.');
 if(!existing.draft)return existing;
 await runGh(['release','edit',release.tag,'--repo',release.repository,'--draft=false','--latest=false']);
 return {...existing,draft:false,published:true};
}

function options(args){const result={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!args[i+1]||Object.hasOwn(result,key))throw Error('Use unique --option value pairs.');result[key]=args[i+1];}return result;}
export async function main([command,...args],directory=root){
 const o=options(args),allowed={prepare:['project','input','declaration','archive','record','source','source-revision','output'],verify:['bundle','project','version','arch'],'verify-assets':['project','version','arch','assets','output'],apply:['bundle'],stage:['bundle','target'],publish:['bundle'],index:['output']}[command];
 if(!allowed||Object.keys(o).some(k=>!allowed.includes(k)))throw Error('Use prepare, verify, apply, stage, publish or index with explicit options.');
 if(command==='prepare'){
  if(!o.project||!o.output)throw Error('prepare requires --project and --output.');
  if(o.declaration){let d=read(o.declaration);if(Array.isArray(d)){d=d.filter(item=>item.id===o.project);if(d.length!==1)throw Error('Declaration must select exactly one project.');d=d[0];}o.declaration=d;}
  if(o.record)o.record=read(o.record);const {'source-revision':sourceRevision,...selected}=o;return prepareRelease({...selected,sourceRevision,directory});
 }
 if(command==='verify-assets')return verifyPublicAssets({...o,directory});
 if(command==='verify')return verifyRelease({...o,directory});
 if(command==='stage')return stageRelease({...o,directory});
 if(command==='publish')return publishRelease({...o,directory});
 if(command==='apply')return applyRelease({...o,directory});
 if(command==='index'){if(!o.output)throw Error('index requires --output.');const result=catalogIndex(directory);fs.mkdirSync(path.dirname(o.output),{recursive:true});fs.writeFileSync(o.output,json(result));return result;}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
