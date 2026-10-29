import fs from 'node:fs';
import path from 'node:path';
import {projectId,repository,version} from './project-identity.mjs';
import {resolveUpstream} from './source-pins.mjs';
const relativeEntry=value=>typeof value==='string'&&value.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)&&part!=='.'&&part!=='..');
export function readProjects(root=path.resolve(import.meta.dirname,'..'),{resolvePins=true}={}){
 const pinCache=new Map();
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'projects.json')));
 const deliveries=['downloadable','bundled'];
 let value=manifest;
 if(manifest.schemaVersion===2){
  if(!manifest.registries||Array.isArray(manifest.registries)||Object.keys(manifest.registries).length!==deliveries.length||deliveries.some(delivery=>!Object.hasOwn(manifest.registries,delivery))||Object.hasOwn(manifest,'projects'))throw Error('Invalid project delivery registries.');
  const files=new Set(),projects=[];
  for(const delivery of deliveries){
   const file=manifest.registries[delivery];
   if(typeof file!=='string'||!/^projects\/[a-z0-9-]+\.json$/.test(file)||files.has(file))throw Error('Invalid project delivery registry path.');
   files.add(file);const entries=JSON.parse(fs.readFileSync(path.join(root,file)));
   if(!Array.isArray(entries)||!entries.length)throw Error('Empty project delivery registry.');
   for(const project of entries){if(!project||typeof project!=='object'||Array.isArray(project)||Object.hasOwn(project,'delivery'))throw Error('Project delivery is determined by its registry.');projects.push({...project,delivery});}
  }
  value={schemaVersion:1,repository:manifest.repository,updatePolicy:manifest.updatePolicy,projects};
 }
 if(value.schemaVersion!==1||value.updatePolicy!=='manual'||!Array.isArray(value.projects)||!value.projects.length)throw Error('Invalid project registry.');
 repository(value.repository);const seen=new Set();
 for(const project of value.projects){
  if(!project||!['downloadable','bundled'].includes(project.delivery))throw Error('Every project requires a delivery classification.');
  projectId(project.id);if(seen.has(project.id)||typeof project.name!=='string'||!project.name.trim()||!['pinned-source','maclauncher','prebuilt'].includes(project.producer?.kind)||!Array.isArray(project.upstreams))throw Error('Invalid or duplicate project registration.');
  if(project.producer.kind==='pinned-source'&&project.producer.recipe!==`runtimes/${project.id}/source.json`)throw Error('Producer recipe belongs to a different project.');
  if(project.producer.kind==='maclauncher'&&(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.producer.repository||'')||!Array.isArray(project.producer.entries)||!project.producer.entries.length||project.producer.entries.some(entry=>!relativeEntry(entry))))throw Error('Invalid MacLauncher producer entries.');
  if(project.producer.sourceDirectory!==undefined&&(!relativeEntry(project.producer.sourceDirectory)||project.producer.entries.some(entry=>!entry.startsWith(project.producer.sourceDirectory+'/'))))throw Error('Producer entries must belong to their public source directory.');
  if(project.producer.kind==='prebuilt'&&(typeof project.producer.version!=='string'||!Array.isArray(project.producer.architectures)||!project.producer.architectures.length||project.producer.architectures.some(arch=>!['arm64','x64'].includes(arch))))throw Error('Invalid prebuilt producer.');
  if(project.packageProfiles!==undefined){
   if(!Array.isArray(project.packageProfiles)||!project.packageProfiles.length)throw Error('Invalid package ABI profiles.');
   const versions=new Set();for(const profile of project.packageProfiles){version(profile.version);if(versions.has(profile.version)||typeof profile.label!=='string'||!profile.label.trim()||profile.label.length>120||Object.keys(profile).some(key=>!['version','label','anchor'].includes(key)))throw Error('Invalid package ABI profiles.');versions.add(profile.version);if(profile.anchor!==undefined)projectId(profile.anchor);}
  }
  if(manifest.schemaVersion===2&&project.upstreams.some(upstream=>!upstream||!Object.hasOwn(upstream,'pin')))throw Error('Project registry upstreams must reference producer source pins.');
  const upstreamIds=new Set();
  project.upstreams=project.upstreams.map(upstream=>resolveUpstream(upstream,root,{resolvePins,cache:pinCache}));
  for(const upstream of project.upstreams){if(!/^[a-z0-9-]+$/.test(upstream.id||'')||upstreamIds.has(upstream.id)||!['github','gitiles','git'].includes(upstream.provider)||!/^https:\/\//.test(upstream.url||'')||!(upstream.pin&&!resolvePins||/^[a-f0-9]{40}$/.test(upstream.revision||'')||typeof upstream.version==='string'&&upstream.version.length))throw Error('Invalid upstream project identity.');const url=new URL(upstream.url);if(url.username||url.password||url.search||url.hash)throw Error('Upstream URL must identify a public source repository.');if(upstream.provider==='github'&&upstream.url!==`https://github.com/${repository(upstream.repository)}`)throw Error('GitHub source URL belongs to a different upstream project.');upstreamIds.add(upstream.id);}
  for(const upstream of project.upstreams)if(upstream.committedAt!==undefined&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(upstream.committedAt)||!Number.isFinite(Date.parse(upstream.committedAt))))throw Error('Invalid pinned source commit timestamp.');
  seen.add(project.id);
 }
 return value;
}
export function resolveProject(id,root=path.resolve(import.meta.dirname,'..'),{resolvePins=true}={}){projectId(id);const registry=readProjects(root,{resolvePins:false}),project=registry.projects.find(project=>project.id===id);if(!project)throw Error('Unknown build project: '+id);const cache=new Map();return {...project,upstreams:project.upstreams.map(upstream=>resolveUpstream(upstream,root,{resolvePins,cache})),releaseRepository:registry.repository};}
