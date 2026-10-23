import fs from 'node:fs';
import path from 'node:path';
import {projectId,repository} from './project-identity.mjs';
const relativeEntry=value=>typeof value==='string'&&value.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)&&part!=='.'&&part!=='..');
export function readProjects(root=path.resolve(import.meta.dirname,'..')){
 const value=JSON.parse(fs.readFileSync(path.join(root,'projects.json')));
 if(value.schemaVersion!==1||value.updatePolicy!=='manual'||!Array.isArray(value.projects)||!value.projects.length)throw Error('Invalid project registry.');
 repository(value.repository);const seen=new Set();
 for(const project of value.projects){
  projectId(project.id);if(seen.has(project.id)||typeof project.name!=='string'||!project.name.trim()||!['pinned-source','maclauncher','prebuilt'].includes(project.producer?.kind)||!Array.isArray(project.upstreams))throw Error('Invalid or duplicate project registration.');
  if(project.producer.kind==='pinned-source'&&project.producer.recipe!==`runtimes/${project.id}/source.json`)throw Error('Producer recipe belongs to a different project.');
  if(project.producer.kind==='maclauncher'&&(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.producer.repository||'')||!Array.isArray(project.producer.entries)||!project.producer.entries.length||project.producer.entries.some(entry=>!relativeEntry(entry))))throw Error('Invalid MacLauncher producer entries.');
  if(project.producer.sourceDirectory!==undefined&&(!relativeEntry(project.producer.sourceDirectory)||project.producer.entries.some(entry=>!entry.startsWith(project.producer.sourceDirectory+'/'))))throw Error('Producer entries must belong to their public source directory.');
  if(project.producer.kind==='prebuilt'&&(typeof project.producer.version!=='string'||!Array.isArray(project.producer.architectures)||!project.producer.architectures.length||project.producer.architectures.some(arch=>!['arm64','x64'].includes(arch))))throw Error('Invalid prebuilt producer.');
  const upstreamIds=new Set();
  for(const upstream of project.upstreams){if(!/^[a-z0-9-]+$/.test(upstream.id||'')||upstreamIds.has(upstream.id)||!['github','gitiles','git'].includes(upstream.provider)||!/^https:\/\//.test(upstream.url||'')||!(/^[a-f0-9]{40}$/.test(upstream.revision||'')||typeof upstream.version==='string'&&upstream.version.length))throw Error('Invalid upstream project identity.');const url=new URL(upstream.url);if(url.username||url.password||url.search||url.hash)throw Error('Upstream URL must identify a public source repository.');if(upstream.provider==='github'&&upstream.url!==`https://github.com/${repository(upstream.repository)}`)throw Error('GitHub source URL belongs to a different upstream project.');upstreamIds.add(upstream.id);}
  seen.add(project.id);
 }
 return value;
}
export function resolveProject(id,root){projectId(id);const registry=readProjects(root),project=registry.projects.find(project=>project.id===id);if(!project)throw Error('Unknown build project: '+id);return {...project,releaseRepository:registry.repository};}
