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
