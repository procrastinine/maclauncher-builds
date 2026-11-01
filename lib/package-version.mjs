import fs from 'node:fs';
import path from 'node:path';
import {resolveProject,readProjects} from './projects.mjs';
import {version} from './project-identity.mjs';
import {ownedPackageSource,sameSourceOwner,plainSemanticVersion} from './source-ownership.mjs';
const records=catalog=>Array.isArray(catalog)?catalog:catalog?.packages||[];
export function nextPackageVersion(upstreamVersion,catalog,{sourceRepository,releaseRepository}={}){
 version(upstreamVersion);
 if(sameSourceOwner(sourceRepository,releaseRepository)){
  if(!plainSemanticVersion(upstreamVersion))throw Error('Owned source packages require a plain semantic version.');
  const used=new Set(records(catalog).map(record=>{const label=typeof record==='string'?record:record.version;return catalog?.versionSemantics?.[label]||label?.replace(/-MCLv[1-9]\d*$/,'');}));
  let selected=upstreamVersion;
  while(used.has(selected)){
   const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(selected);
   if(!match||!Number.isSafeInteger(Number(match[3])+1))throw Error('Select a new plain semantic version.');
   selected=match[1]+'.'+match[2]+'.'+(Number(match[3])+1);
  }
  return selected;
 }
 const prefix=upstreamVersion+'-MCLv';let highest=0;
 for(const record of records(catalog)){const value=typeof record==='string'?record:record.version;if(value?.startsWith(prefix)&&/^[1-9]\d*$/.test(value.slice(prefix.length)))highest=Math.max(highest,Number(value.slice(prefix.length)));}
 if(!Number.isSafeInteger(highest)||highest>=Number.MAX_SAFE_INTEGER)throw Error('Package revision exceeds its limit.');
 return upstreamVersion+'-MCLv'+(highest+1);
}
export function nextSnapshotVersion(committedAt,catalog,{sourceRepository,releaseRepository}={}){
 if(sameSourceOwner(sourceRepository,releaseRepository))throw Error('Owned source packages require a plain semantic version, not an MCL snapshot.');
 const date=new Date(committedAt);if(!/^\d{4}-\d{2}-\d{2}T/.test(committedAt||'')||!Number.isFinite(date.valueOf()))throw Error('An exact upstream commit timestamp is required.');let highest=0;
 for(const record of records(catalog)){const value=typeof record==='string'?record:record.version,match=/^MCLv([1-9]\d*)-\d{4}$/.exec(value||'');if(match)highest=Math.max(highest,Number(match[1]));}
 if(!Number.isSafeInteger(highest)||highest>=Number.MAX_SAFE_INTEGER)throw Error('Package revision exceeds its limit.');
 return 'MCLv'+(highest+1)+'-'+date.toISOString().slice(5,10).replace('-','');
}

const root=path.resolve(import.meta.dirname,'..');
/** Release versions are explicitly declared; hashes identify upstream sources only. */
export function releaseVersion(project,value,directory=root){
 const registered=resolveProject(project,directory,{resolvePins:false});
 const profiles=registered.packageProfiles||[];
 if(value===undefined){if(profiles.length!==1)throw Error('Select an explicitly declared release version.');value=profiles[0].version;}
 version(value);
 if(!profiles.some(profile=>profile.version===value))throw Error('Release version is not declared in the project package profiles.');
 const hashes=value.split(/[._-]/).filter(part=>/^[a-f0-9]{7,}$/i.test(part));
 if(hashes.length){const sources=resolveProject(project,directory).upstreams;for(const hash of hashes)if(!sources.some(source=>source.revision?.startsWith(hash.toLowerCase())))throw Error('Release version hash must identify a declared upstream revision.');}
 return value;
}

/** New builds follow source ownership. Published legacy identities remain
 * valid for verification, lookup and reproducible historical builds. */
export function buildReleaseVersion(project,value,directory=root){
 value=releaseVersion(project,value,directory);
 const registered=resolveProject(project,directory,{resolvePins:false});
 if(ownedPackageSource(registered,registered.releaseRepository,directory)&&!plainSemanticVersion(value)){
  let published=[];
  try{published=JSON.parse(fs.readFileSync(path.join(directory,'catalogs',project+'.json'))).packages;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!published.some(record=>record.version===value))throw Error('Owned source packages require a plain semantic version for a new build.');
 }
 return value;
}

/** Low-level archive/catalog tools also enforce registered product ownership. */
export function outputVersion(project,value,directory=root){
 const registry=readProjects(directory,{resolvePins:false}),registered=registry.projects.find(row=>row.id===project);
 if(registered&&ownedPackageSource(registered,registry.repository,directory)&&!plainSemanticVersion(value))buildReleaseVersion(project,value,directory);
 return value;
}
