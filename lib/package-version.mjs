import path from 'node:path';
import {resolveProject} from './projects.mjs';
import {version} from './project-identity.mjs';
const records=catalog=>Array.isArray(catalog)?catalog:catalog?.packages||[];
export function nextPackageVersion(upstreamVersion,catalog){
 version(upstreamVersion);const prefix=upstreamVersion+'-MCLv';let highest=0;
 for(const record of records(catalog)){const value=typeof record==='string'?record:record.version;if(value?.startsWith(prefix)&&/^[1-9]\d*$/.test(value.slice(prefix.length)))highest=Math.max(highest,Number(value.slice(prefix.length)));}
 if(!Number.isSafeInteger(highest)||highest>=Number.MAX_SAFE_INTEGER)throw Error('Package revision exceeds its limit.');
 return upstreamVersion+'-MCLv'+(highest+1);
}
export function nextSnapshotVersion(committedAt,catalog){
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
