import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readProjects,buildRecords} from '../lib/projects.mjs';
import {releaseRecord,validateCatalog} from '../lib/project-identity.mjs';
import {readPublisherInput,verifyPublisherRecord} from './publisher-files.mjs';
const root=path.resolve(import.meta.dirname,'..');
const verifiedCoverages=new WeakMap();
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const key=record=>[record.id,record.version,record.arch,record.asset.sha256].join('/');
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;}

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

/** Recorded workflow identity. Users verify the linked attestation with gh. */
export function requireGithubBuild({record,repository,archive,sourceRevision}){
 releaseRecord(record,{project:record?.id,repository});
 const build=record.build;
 if(!build?.sourceRevision||build.workflow!==repository+'/.github/workflows/runtime-build.yml')throw Error('The package has no recorded Build and release source.');
 if(sourceRevision!==undefined&&sourceRevision!==build.sourceRevision)throw Error('The publication source differs from the recorded build commit.');
 if(archive){const stat=fs.lstatSync(archive);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==record.asset.bytes)throw Error('The archive size differs from its recorded identity.');
  const fd=fs.openSync(archive,'r'),buffer=Buffer.alloc(1024*1024),hash=crypto.createHash('sha256');
  try{let length;while((length=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,length));}finally{fs.closeSync(fd);}
  if(hash.digest('hex')!==record.asset.sha256)throw Error('The archive digest differs from its recorded identity.');
 }
 return {...build,repository,runId:String(build.runId),runAttempt:String(build.runAttempt||'1'),runUrl:'https://github.com/'+repository+'/actions/runs/'+build.runId};
}

/** Offline inventory of catalog records and their external attestation links. */
export function buildCoverage(directory=root){
 directory=fs.realpathSync(directory);
 const registry=readProjects(directory,{resolvePins:false}),projects=new Map(registry.projects.map(project=>[project.id,project]));
 const projectViews=registry.projects.map(project=>({projectId:project.id,name:project.name,delivery:project.delivery,authorityPolicy:readPublisherInput({project,directory})?'supplied-publisher':'github-build'}));
 const publisherBuilds=new Map(),publisherLedger=path.join(directory,'publisher-records');
 if(fs.existsSync(publisherLedger))for(const name of fs.readdirSync(publisherLedger).sort()){
  if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
  const entry=read(path.join(publisherLedger,name)),record=entry.record,project=projects.get(record?.id);
  if(!project)throw Error('Supplied-file equality evidence names an unregistered project.');
  if(name!==record.asset?.sha256+'.json')throw Error('Supplied-file equality filename differs from its archive digest.');
  const proof=verifyPublisherRecord({record,repository:registry.repository,directory});if(!proof)throw Error('Supplied-file evidence has no registered publisher input.');
  const blob=file=>'https://github.com/'+registry.repository+'/blob/main/'+file;
  publisherBuilds.set(key(record),{projectId:record.id,name:project.name,delivery:project.delivery,version:record.version,arch:record.arch,
   minimumMacOS:record.minimumMacOS,asset:record.asset,record,catalogPublished:false,publisherProof:{publisherInput:blob(proof.input.file),publisherRecord:blob(proof.recordPath),publisherVersion:proof.publisherVersion,publisherAuthenticated:false,publisherFiles:proof.files}});
 }
 const catalogPackages=[],githubBuilds=[];
 for(const project of registry.projects){
  const file=path.join(directory,'catalogs',project.id+'.json');if(!fs.existsSync(file))continue;
  for(const record of validateCatalog(read(file),{project:project.id,repository:registry.repository,allowEmpty:true}).packages){
   const publisherBuild=publisherBuilds.get(key(record));let githubBuild;
   if(publisherBuild){verifyPublisherRecord({record,repository:registry.repository,directory});publisherBuild.catalogPublished=true;publisherBuild.asset=record.asset;}
   if(record.build||!publisherBuild){githubBuild={projectId:record.id,name:project.name,delivery:project.delivery,version:record.version,arch:record.arch,minimumMacOS:record.minimumMacOS,asset:record.asset,...requireGithubBuild({record,repository:registry.repository}),attestation:{url:'https://api.github.com/repos/'+registry.repository+'/attestations/sha256:'+record.asset.sha256},record};githubBuilds.push(githubBuild);}
   catalogPackages.push({projectId:project.id,name:project.name,delivery:project.delivery,record,origin:githubBuild?'github':'supplied-publisher',...(githubBuild?{githubBuild}:{}),...(publisherBuild?{publisherProof:publisherBuild.publisherProof}:{})});
  }
 }
 catalogPackages.sort((a,b)=>a.projectId.localeCompare(b.projectId)||a.record.version.localeCompare(b.record.version)||a.record.arch.localeCompare(b.record.arch));
 githubBuilds.sort((a,b)=>a.projectId.localeCompare(b.projectId)||a.version.localeCompare(b.version)||a.arch.localeCompare(b.arch));
 const publisherPackages=[...publisherBuilds.values()].sort((a,b)=>a.projectId.localeCompare(b.projectId)||a.version.localeCompare(b.version)||a.arch.localeCompare(b.arch)),publisherIds=new Set(publisherPackages.map(row=>row.projectId));
 const builtProjects=new Set(githubBuilds.map(row=>row.projectId)),outputs=new Set(githubBuilds.map(row=>[row.projectId,row.version,row.arch].join('/')));
 const missingOutputs=id=>currentBuildOutputs(projects.get(id)).filter(({version,arch})=>!outputs.has([id,version,arch].join('/')));
 const completeProjects=new Set(registry.projects.filter(project=>project.build!==undefined&&!missingOutputs(project.id).length).map(project=>project.id));
 const versions=id=>[...new Set([...(projects.get(id).packageProfiles||[]).map(profile=>profile.version),...catalogPackages.filter(row=>row.projectId===id).map(row=>row.record.version),...publisherPackages.filter(row=>row.projectId===id).map(row=>row.version)])];
 const describe=project=>({...project,hasBuildCommand:projects.get(project.projectId).build!==undefined,hasGithubBuild:builtProjects.has(project.projectId),githubBuildComplete:completeProjects.has(project.projectId),missingGithubOutputs:missingOutputs(project.projectId),hasPublisherProof:publisherIds.has(project.projectId),versions:versions(project.projectId)});
 const githubProjects=projectViews.filter(project=>project.authorityPolicy==='github-build'&&projects.get(project.projectId).build!==undefined),projectsWithoutGithubBuild=githubProjects.filter(project=>!completeProjects.has(project.projectId)).map(describe).sort((a,b)=>a.projectId.localeCompare(b.projectId));
 const publisherProjects=projectViews.filter(project=>project.authorityPolicy==='supplied-publisher').map(describe);
 const projectsWithoutPublisherProof=publisherProjects.filter(project=>!project.hasPublisherProof),projectsWithoutAuthority=[...projectsWithoutGithubBuild,...projectsWithoutPublisherProof].sort((a,b)=>a.projectId.localeCompare(b.projectId));
 const coverage={repository:registry.repository,summary:{projects:registry.projects.length,catalogPackages:catalogPackages.length,githubBuildOutputs:githubBuilds.length,
  projectsWithGithubBuild:githubProjects.length-projectsWithoutGithubBuild.length,declaredOutputsWithoutGithubBuild:githubProjects.reduce((total,project)=>total+missingOutputs(project.projectId).length,0),projectsWithAnyGithubBuild:builtProjects.size,projectsWithoutGithubBuild:projectsWithoutGithubBuild.length,
  projectsRequiringGithubBuild:githubProjects.length,projectsWithPublisherFiles:publisherProjects.length,suppliedPublisherProjects:publisherProjects.filter(project=>project.hasPublisherProof).length,suppliedPublisherPackages:publisherPackages.length,projectsWithoutPublisherProof:projectsWithoutPublisherProof.length,projectsWithoutAuthority:projectsWithoutAuthority.length},
  projects:projectViews,catalogPackages,githubBuilds,publisherPackages,publisherProjects,projectsWithoutGithubBuild,projectsWithoutPublisherProof,projectsWithoutAuthority};
 freeze(coverage);verifiedCoverages.set(coverage,directory);return coverage;
}

/** Only this module can supply the immutable catalog view from this source tree. */
export function assertBuildCoverage(coverage,directory=root){
 if(verifiedCoverages.get(coverage)!==fs.realpathSync(directory))throw Error('Catalog generation requires catalog build coverage from this source tree.');
 return coverage;
}
