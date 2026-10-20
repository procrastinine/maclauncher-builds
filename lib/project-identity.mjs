import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{safeFile}=require('./archive.cjs');
const SHA=/^[a-f0-9]{64}$/;
export function projectId(value){
 if(typeof value!=='string'||value.length>80||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))throw Error('Invalid project ID.');return value;
}
export function version(value){
 if(typeof value!=='string'||value.length>128||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)||value.includes('..')||value.endsWith('.')||value.endsWith('.lock'))throw Error('Invalid runtime version.');return value;
}
export function identity({id,version:value,arch}){
 projectId(id);version(value);if(!['arm64','x64','universal'].includes(arch))throw Error('Invalid package architecture.');return {id,version:value,arch};
}
export function assetName(value){const {id,version,arch}=identity(value);return `${id}-${version}-${arch}.tar.gz`;}
export function releaseTag(value){const {id,version,arch}=identity(value);return `${id}/v${version}/${arch}`;}
export function repository(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)||value.includes('..')||value.split('/').some(part=>part.endsWith('.')))throw Error('Use an explicit GitHub owner/repository.');return value;}
export function assetUrl(value,repo){return `https://github.com/${repository(repo)}/releases/download/${encodeURIComponent(releaseTag(value))}/${assetName(value)}`;}
export function publicMetadata(value){if(/(?:\/Users\/|\/home\/|file:\/\/|(?:password|accessToken|refreshToken|logPath|evidenceSource)"\s*:)/i.test(JSON.stringify(value)))throw Error('Package metadata contains private paths or fields.');}
export function releaseRecord(record,{project,repository:repo,requireUrl=false}={}){
 projectId(project);identity(record||{});
 if(record.id!==project)throw Error(`Package belongs to ${record.id}; expected project ${project}.`);
 const keys=['schemaVersion','id','version','arch','launcherArchitectures','minimumMacOS','manifestRelative','manifestSha256','sourceSha256','updatePolicy','tag','asset'];
 if(record.schemaVersion!==2||Object.keys(record).some(key=>!keys.includes(key))||record.updatePolicy!=='manual'||
  !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(record.minimumMacOS||'')||Number(record.minimumMacOS.split('.')[0])<1||
  !Array.isArray(record.launcherArchitectures)||!record.launcherArchitectures.length||new Set(record.launcherArchitectures).size!==record.launcherArchitectures.length||
  record.launcherArchitectures.some(arch=>!['arm64','x64'].includes(arch))||
  !SHA.test(record.manifestSha256||'')||!SHA.test(record.sourceSha256||'')||
  !record.asset||Object.keys(record.asset).some(key=>!['filename','sha256','bytes','url'].includes(key))||
  record.asset.filename!==assetName(record)||!SHA.test(record.asset.sha256||'')||
  !Number.isSafeInteger(record.asset.bytes)||record.asset.bytes<1||record.asset.bytes>4*1024**3)throw Error('Invalid runtime release record.');
 safeFile(record.manifestRelative);
 if(record.tag!==undefined&&record.tag!==releaseTag(record))throw Error('Release tag belongs to a different project or version.');
 if(requireUrl&&(record.tag===undefined||record.asset.url===undefined))throw Error('Catalog release tag and download URL are required.');
 if(record.asset.url!==undefined&&record.asset.url!==assetUrl(record,repo))throw Error('Download URL belongs to a different project, version or repository.');
 publicMetadata(record);return record;
}
export function validateCatalog(value,{project,repository:repo}={}){
 projectId(project);repository(repo);
 if(!value||value.schemaVersion!==2||value.projectId!==project||value.updatePolicy!=='manual'||
  Object.keys(value).some(key=>!['schemaVersion','projectId','updatePolicy','packages'].includes(key))||
  !Array.isArray(value.packages)||!value.packages.length||value.packages.length>20000)throw Error('Catalog belongs to a different project or has an invalid format.');
 const seen=new Set();for(const record of value.packages){releaseRecord(record,{project,repository:repo,requireUrl:true});const key=record.version+'/'+record.arch;if(seen.has(key))throw Error('Duplicate project/version/architecture.');seen.add(key);}
 return value;
}
