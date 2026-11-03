import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Contract=require('./package-contract.cjs');
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
export function publicMetadata(value){return Contract.validatePublicMetadata(value);}
export function releaseRecord(record,{project,repository:repo,requireUrl=false}={}){
 projectId(project);identity(record||{});
 if(record.id!==project)throw Error(`Package belongs to ${record.id}; expected project ${project}.`);
 try{Contract.packageRecord(record,{projectId:project,repository:repo,publication:true,requireUrl});}
 catch(error){throw Error('Invalid runtime release record. '+error.message,{cause:error});}
 return record;
}
export function validateCatalog(value,{project,repository:repo,allowEmpty=false}={}){
 projectId(project);repository(repo);
 if(!value||value.schemaVersion!==2||value.projectId!==project||value.updatePolicy!=='manual'||
  Object.keys(value).some(key=>!['schemaVersion','projectId','updatePolicy','packages'].includes(key))||
  !Array.isArray(value.packages)||!allowEmpty&&!value.packages.length||value.packages.length>20000)throw Error('Catalog belongs to a different project or has an invalid format.');
 const seen=new Set();for(const record of value.packages){releaseRecord(record,{project,repository:repo,requireUrl:true});const key=record.version+'/'+record.arch;if(seen.has(key))throw Error('Duplicate project/version/architecture.');seen.add(key);}
 return value;
}
