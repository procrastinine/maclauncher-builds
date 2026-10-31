import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {verifyRelease} from './release-runtime.mjs';
import {verify} from './runtime-package.mjs';
import {readProjects} from '../lib/projects.mjs';
import {releaseRecord} from '../lib/project-identity.mjs';
import {verifyBuildEvidence} from '../lib/github-builds.mjs';
import {readGithubBuild} from './build-coverage.mjs';
const root=path.resolve(import.meta.dirname,'..');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const payloadFields=['id','version','arch','launcherArchitectures','minimumMacOS','manifestRelative','manifestSha256','sourceSha256'];

/** Import signed evidence for exact verified bytes. No catalog or release is changed. */
export async function recordGithubBuild({archive,record,bundle,directory=root,runGh=execFileSync}){
 const repository=readProjects(directory,{resolvePins:false}).repository;
 releaseRecord(record,{project:record?.id,repository});
 const stat=fs.lstatSync(archive);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==record.asset.bytes)throw Error('The archive size differs from its package record.');
 const checked=await verify({archive,sha256:record.asset.sha256,project:record.id,version:record.version,arch:record.arch,includeDeclaration:true});
 for(const key of payloadFields)if(JSON.stringify(checked.declaration[key])!==JSON.stringify(record[key]))throw Error('The archive payload differs from its package record: '+key);
 if(!bundle){
  const source=record.build?.sourceRevision||(record.source?.repository===repository?record.source.revision:undefined);
  const args=['attestation','verify',archive,'--repo',repository,'--signer-workflow',repository+'/.github/workflows/runtime-build.yml','--deny-self-hosted-runners','--format','json',...(source?['--source-digest',source]:[])];
  bundle=JSON.parse(await runGh('gh',args,{encoding:'utf8',stdio:['ignore','pipe','inherit']}));
 }
 const candidates=Array.isArray(bundle)?bundle.map(row=>row.attestation?.bundle||row.bundle||row):[bundle.bundle||bundle];
 let selected,evidence,lastError;
 for(const candidate of candidates){try{evidence=verifyBuildEvidence({record,repository,bundle:candidate});selected=candidate;break;}catch(error){lastError=error;}}
 if(!selected)throw Error('No valid signed Runtime build evidence identifies this exact archive.',{cause:lastError});
 const output=path.join(directory,'attestations',record.asset.sha256+'.json');
 if(fs.existsSync(output)){
  const existing=readGithubBuild(output,{repository});
  if(payloadFields.some(key=>JSON.stringify(existing.record[key])!==JSON.stringify(record[key]))||existing.record.asset.bytes!==record.asset.bytes)throw Error('Existing signed build evidence has conflicting package metadata.');
  const existingEvidence=verifyBuildEvidence({record,repository,bundle:read(output).bundle});
  return {id:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256,...existingEvidence,existing:true};
 }
 fs.mkdirSync(path.dirname(output),{recursive:true});
 fs.writeFileSync(output,JSON.stringify({schemaVersion:1,record,bundle:selected},null,2)+'\n',{flag:'wx'});
 return {id:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256,...evidence,existing:false};
}

export async function main(args,directory=root){
 const options={};for(let at=0;at<args.length;at+=2){const key=args[at]?.slice(2);if(!args[at]?.startsWith('--')||!['release-bundle','archive','record','bundle'].includes(key)||!args[at+1]||Object.hasOwn(options,key))throw Error('Use --release-bundle <directory> or --archive <file> --record <file>, with optional --bundle <signed-json>.');options[key]=args[at+1];}
 let record,archive;
 if(options['release-bundle']){
  if(options.archive||options.record)throw Error('Select one release bundle or one archive and record.');
  const checked=await verifyRelease({bundle:options['release-bundle'],directory});record=checked.record;archive=path.join(options['release-bundle'],record.asset.filename);
 }else{if(!options.archive||!options.record)throw Error('An exact archive and package record are required.');record=read(options.record);archive=options.archive;}
 return recordGithubBuild({archive,record,bundle:options.bundle?read(options.bundle):undefined,directory});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
