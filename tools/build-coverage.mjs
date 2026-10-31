import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {releaseRecord,validateCatalog} from '../lib/project-identity.mjs';
import {verifyBuildEvidence} from '../lib/github-builds.mjs';
import {readPublisherInput,verifyPublisherRecord} from './publisher-files.mjs';
const root=path.resolve(import.meta.dirname,'..'),SHA=/^[a-f0-9]{64}$/;
const verifiedCoverages=new WeakMap();
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const key=record=>[record.id,record.version,record.arch,record.asset.sha256].join('/');
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;}
function recordMatches(a,b){return key(a)===key(b)&&a.asset.filename===b.asset.filename&&a.asset.bytes===b.asset.bytes;}

/** Current packaging revision of each maintained version line, for each CPU. */
export function currentBuildOutputs(project){
 if(project.build===undefined)return [];
 const selected=new Map();
 for(const build of buildRecords(project)){
  const revision=/(?:^|-)MCLv([1-9]\d*)/.exec(build.version),line=revision?build.version.replace(revision[0],''):build.version;
  for(const arch of build.architectures)for(const cpu of arch==='universal'?['arm64','x64']:[arch]){
   const key=JSON.stringify([line,cpu]),old=selected.get(key),number=BigInt(revision?.[1]||0);
   if(!old||number>old.number||number===old.number&&old.arch==='universal'&&arch===cpu)selected.set(key,{version:build.version,arch,number});
  }
 }
 return [...new Map([...selected.values()].map(({version,arch})=>[version+'/'+arch,{version,arch}])).values()];
}

/** Ledger entries contain signed bundles, never a self-declared verification flag. */
export function readGithubBuild(file,{repository}){
 const entry=read(file);
 if(!entry||entry.schemaVersion!==1||Object.keys(entry).some(key=>!['schemaVersion','record','bundle'].includes(key)))throw Error('Invalid GitHub build evidence ledger entry.');
 releaseRecord(entry.record,{project:entry.record?.id,repository});
 if(path.basename(file)!==entry.record.asset.sha256+'.json')throw Error('GitHub build evidence filename differs from its archive digest.');
 const evidence=verifyBuildEvidence({record:entry.record,repository,bundle:entry.bundle});
 return {record:entry.record,evidence};
}

export function verifiedArchiveBuild({record,repository,directory=root}){
 if(!SHA.test(record?.asset?.sha256||''))throw Error('Select an exact archive digest.');
 const file=path.join(directory,'attestations',record.asset.sha256+'.json');
 if(!fs.existsSync(file))return undefined;
 const verified=readGithubBuild(file,{repository});
 if(!recordMatches(verified.record,record))throw Error('GitHub build evidence belongs to a different package identity.');
 return verifyBuildEvidence({record,repository,bundle:read(file).bundle});
}

function archiveDigest(file){
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Select a regular archive for GitHub build verification.');
 const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024),hash=crypto.createHash('sha256');
 try{let length;while((length=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,length));}finally{fs.closeSync(fd);}
 return {sha256:hash.digest('hex'),bytes:stat.size};
}

/** Publication cannot substitute local bytes, metadata or a different recipe commit. */
export function requireGithubBuild({record,repository,directory=root,archive,sourceRevision}){
 const evidence=verifiedArchiveBuild({record,repository,directory});
 if(!evidence)throw Error(`Built locally — no GitHub build record yet: ${record.id} ${record.version} ${record.arch} (${record.asset.sha256}). Import its signed Runtime build evidence before publication.`);
 if(sourceRevision!==undefined&&sourceRevision!==evidence.sourceRevision)throw Error('The publication source differs from the signed GitHub build commit.');
 if(archive){const actual=archiveDigest(archive);if(actual.sha256!==record.asset.sha256||actual.bytes!==record.asset.bytes)throw Error('The archive differs from its signed GitHub build identity.');}
 return evidence;
}

/** Preserve unsigned history separately; malformed signed evidence is never ignored. */
export function partitionCatalog({records,repository,directory=root}){
 const github=[],publisher=[],local=[];
 for(const record of records){
  releaseRecord(record,{project:record.id,repository});
  (verifiedArchiveBuild({record,repository,directory})?github:verifyPublisherRecord({record,repository,directory})?publisher:local).push(record);
 }
 return {github,publisher,active:[...github,...publisher],local};
}

/** Offline inventory. Every claimed GitHub output is cryptographically verified. */
export function buildCoverage(directory=root){
 directory=fs.realpathSync(directory);
 const registry=readProjects(directory,{resolvePins:false}),projects=new Map(registry.projects.map(project=>[project.id,project]));
 const page='https://'+registry.repository.split('/')[0]+'.github.io/'+registry.repository.split('/')[1]+'/';
 const historyUrl=id=>new URL('verification.html#project-'+id,page).href;
 const successor=project=>({projectId:project.id,name:project.name,url:historyUrl(project.id)});
 const publisherInputs=new Map(registry.projects.map(project=>[project.id,readPublisherInput({project,directory})]).filter(([,input])=>input));
 const projectViews=registry.projects.map(project=>{
  const retired=project.supersededBy!==undefined;
  let terminal=project;if(retired)while(terminal.supersededBy!==undefined)terminal=projects.get(terminal.supersededBy);
  return {projectId:project.id,name:project.name,delivery:project.delivery,authorityPolicy:publisherInputs.has(project.id)?'supplied-publisher':'github-build',state:retired?'retired':'active',historyUrl:historyUrl(project.id),
   ...(retired?{supersededBy:project.supersededBy,successor:successor(projects.get(project.supersededBy)),activeSuccessor:successor(terminal)}:{})};
 });
 const views=new Map(projectViews.map(project=>[project.projectId,project]));
 const projectFacts=id=>{const view=views.get(id);return {projectState:view.state,authorityPolicy:view.authorityPolicy,historyUrl:view.historyUrl,
  ...(view.state==='retired'?{supersededBy:view.supersededBy,successor:view.successor,activeSuccessor:view.activeSuccessor}:{})};};
 const ledger=path.join(directory,'attestations'),builds=new Map();
 if(fs.existsSync(ledger))for(const name of fs.readdirSync(ledger).sort()){
  if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
  const {record,evidence}=readGithubBuild(path.join(ledger,name),{repository:registry.repository}),project=projects.get(record.id);
  if(!project)throw Error('GitHub build evidence names an unregistered project: '+record.id);
  const identity=key(record);if(builds.has(identity))throw Error('Duplicate signed GitHub package identity.');
  builds.set(identity,{projectId:record.id,name:project.name,delivery:project.delivery,...projectFacts(record.id),version:record.version,arch:record.arch,
   minimumMacOS:record.minimumMacOS,asset:record.asset,sourceRevision:evidence.sourceRevision,runId:evidence.runId,runAttempt:evidence.runAttempt,
   workflow:evidence.workflow,catalogPublished:false,
   attestation:{url:'https://api.github.com/repos/'+registry.repository+'/attestations/sha256:'+record.asset.sha256,bundlePath:'attestations/'+name},record});
 }
 const publisherBuilds=new Map(),publisherLedger=path.join(directory,'publisher-records');
 if(fs.existsSync(publisherLedger))for(const name of fs.readdirSync(publisherLedger).sort()){
  if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
  const entry=read(path.join(publisherLedger,name)),record=entry.record,project=projects.get(record?.id);
  if(!project)throw Error('Supplied-file equality evidence names an unregistered project.');
  if(name!==record.asset?.sha256+'.json')throw Error('Supplied-file equality filename differs from its archive digest.');
  const proof=verifyPublisherRecord({record,repository:registry.repository,directory});if(!proof)throw Error('Supplied-file evidence has no registered publisher input.');
  const blob=file=>'https://github.com/'+registry.repository+'/blob/main/'+file;
  publisherBuilds.set(key(record),{projectId:record.id,name:project.name,delivery:project.delivery,...projectFacts(record.id),version:record.version,arch:record.arch,
   minimumMacOS:record.minimumMacOS,asset:record.asset,record,catalogPublished:false,publisherProof:{publisherInput:blob(proof.input.file),publisherRecord:blob(proof.recordPath),publisherVersion:proof.publisherVersion,publisherAuthenticated:false,publisherFiles:proof.files}});
 }
 const catalogPackages=[],seenCatalog=new Map();
 for(const project of registry.projects)for(const sourceState of ['active','superseded']){
  const file=path.join(directory,'catalogs',...(sourceState==='superseded'?['superseded']:[]),project.id+'.json');if(!fs.existsSync(file))continue;
  const catalog=validateCatalog(read(file),{project:project.id,repository:registry.repository,allowEmpty:true});
  for(const record of catalog.packages){
   const identity=[record.id,record.version,record.arch].join('/'),old=seenCatalog.get(identity);
   if(old){if(JSON.stringify(old)!==JSON.stringify(record))throw Error('Active and superseded catalogs disagree about an immutable package.');continue;}
   seenCatalog.set(identity,record);
   const githubBuild=builds.get(key(record)),publisherBuild=publisherBuilds.get(key(record));
   if(publisherBuild){verifyPublisherRecord({record,repository:registry.repository,directory});if(sourceState==='active'){publisherBuild.catalogPublished=true;publisherBuild.asset=record.asset;}}
   if(githubBuild&&!recordMatches(githubBuild.record,record))throw Error('Catalog and signed build ledger disagree about the archive identity.');
   if(githubBuild){verifyBuildEvidence({record,repository:registry.repository,bundle:read(path.join(directory,githubBuild.attestation.bundlePath)).bundle});if(sourceState==='active')githubBuild.catalogPublished=true;}
   catalogPackages.push({projectId:project.id,name:project.name,delivery:project.delivery,...projectFacts(project.id),record,origin:githubBuild?'github':publisherBuild?'supplied-publisher':'local',catalogState:(githubBuild||publisherBuild)&&sourceState==='active'?'active':'superseded',...(githubBuild?{githubBuild}:{}),...(publisherBuild?{publisherProof:publisherBuild.publisherProof}:{})});
  }
 }
 catalogPackages.sort((a,b)=>a.projectId.localeCompare(b.projectId)||a.record.version.localeCompare(b.record.version)||a.record.arch.localeCompare(b.record.arch));
 const githubBuilds=[...builds.values()].sort((a,b)=>a.projectId.localeCompare(b.projectId)||a.version.localeCompare(b.version)||a.arch.localeCompare(b.arch));
 const publisherPackages=[...publisherBuilds.values()].sort((a,b)=>a.projectId.localeCompare(b.projectId)||a.version.localeCompare(b.version)||a.arch.localeCompare(b.arch)),publisherIds=new Set(publisherPackages.map(row=>row.projectId));
 const builtProjects=new Set(githubBuilds.map(row=>row.projectId)),activeProjects=projectViews.filter(project=>project.state==='active');
 // Historical revisions remain visible but never add missing current outputs.
 const outputs=new Set(githubBuilds.map(row=>[row.projectId,row.version,row.arch].join('/')));
 const missingOutputs=id=>currentBuildOutputs(projects.get(id)).filter(({version,arch})=>!outputs.has([id,version,arch].join('/')));
 const completeProjects=new Set(registry.projects.filter(project=>project.build!==undefined&&!missingOutputs(project.id).length).map(project=>project.id));
 const versions=id=>[...new Set([...(projects.get(id).packageProfiles||[]).map(profile=>profile.version),...catalogPackages.filter(row=>row.projectId===id).map(row=>row.record.version),...githubBuilds.filter(row=>row.projectId===id).map(row=>row.version),...publisherPackages.filter(row=>row.projectId===id).map(row=>row.version)])];
 const describe=project=>({...project,hasBuildCommand:projects.get(project.projectId).build!==undefined,hasGithubBuild:builtProjects.has(project.projectId),githubBuildComplete:completeProjects.has(project.projectId),missingGithubOutputs:missingOutputs(project.projectId),hasPublisherProof:publisherIds.has(project.projectId),versions:versions(project.projectId)});
 const projectsWithoutGithubBuild=activeProjects.filter(project=>project.authorityPolicy==='github-build'&&!completeProjects.has(project.projectId)).map(describe).sort((a,b)=>a.projectId.localeCompare(b.projectId));
 const retiredProjects=projectViews.filter(project=>project.state==='retired').map(describe).sort((a,b)=>a.projectId.localeCompare(b.projectId));
 const publisherProjects=activeProjects.filter(project=>project.authorityPolicy==='supplied-publisher').map(describe);
 const projectsWithoutPublisherProof=publisherProjects.filter(project=>!project.hasPublisherProof),projectsWithoutAuthority=[...projectsWithoutGithubBuild,...projectsWithoutPublisherProof].sort((a,b)=>a.projectId.localeCompare(b.projectId));
 const coverage={repository:registry.repository,summary:{projects:registry.projects.length,activeProjects:activeProjects.length,retiredProjects:retiredProjects.length,
  catalogPackages:catalogPackages.length,activeCatalogPackages:catalogPackages.filter(row=>row.projectState==='active').length,retiredCatalogPackages:catalogPackages.filter(row=>row.projectState==='retired').length,
  githubCatalogPackages:catalogPackages.filter(row=>row.projectState==='active'&&row.origin==='github'&&row.catalogState==='active').length,localCatalogPackages:catalogPackages.filter(row=>row.origin==='local').length,
  githubBuildOutputs:githubBuilds.length,activeGithubBuildOutputs:githubBuilds.filter(row=>row.projectState==='active').length,retiredGithubBuildOutputs:githubBuilds.filter(row=>row.projectState==='retired').length,
  unpublishedGithubBuildOutputs:githubBuilds.filter(row=>row.projectState==='active'&&!row.catalogPublished).length,retiredUnpublishedGithubBuildOutputs:githubBuilds.filter(row=>row.projectState==='retired'&&!row.catalogPublished).length,
  projectsWithGithubBuild:activeProjects.filter(project=>project.authorityPolicy==='github-build'&&completeProjects.has(project.projectId)).length,declaredOutputsWithoutGithubBuild:activeProjects.filter(project=>project.authorityPolicy==='github-build').reduce((total,project)=>total+missingOutputs(project.projectId).length,0),activeProjectsWithGithubBuild:activeProjects.filter(project=>project.authorityPolicy==='github-build'&&completeProjects.has(project.projectId)).length,activeProjectsWithAnyGithubBuild:activeProjects.filter(project=>builtProjects.has(project.projectId)).length,projectsWithoutGithubBuild:projectsWithoutGithubBuild.length,
  projectsRequiringGithubBuild:activeProjects.filter(project=>project.authorityPolicy==='github-build').length,projectsWithPublisherFiles:publisherProjects.length,suppliedPublisherProjects:publisherProjects.filter(project=>project.hasPublisherProof).length,suppliedPublisherPackages:publisherPackages.length,activeSuppliedPublisherPackages:publisherPackages.filter(row=>row.projectState==='active').length,retiredSuppliedPublisherPackages:publisherPackages.filter(row=>row.projectState==='retired').length,projectsWithoutPublisherProof:projectsWithoutPublisherProof.length,projectsWithoutAuthority:projectsWithoutAuthority.length,
  retiredProjectsWithGithubBuild:retiredProjects.filter(project=>project.hasGithubBuild).length,retiredProjectsWithoutGithubBuild:retiredProjects.filter(project=>!project.hasGithubBuild).length},
  projects:projectViews,catalogPackages,githubBuilds,publisherPackages,publisherProjects,projectsWithoutGithubBuild,projectsWithoutPublisherProof,projectsWithoutAuthority,retiredProjects};
 freeze(coverage);verifiedCoverages.set(coverage,directory);return coverage;
}

/** Only this module can supply the immutable catalog view with verified publication authority. */
export function assertBuildCoverage(coverage,directory=root){
 if(verifiedCoverages.get(coverage)!==fs.realpathSync(directory))throw Error('Catalog generation requires verified GitHub build coverage from this source tree.');
 return coverage;
}
