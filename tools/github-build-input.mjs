import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {sha} from './helper-package.mjs';
import {verify} from './runtime-package.mjs';
import {verifyBuildEvidence} from '../lib/github-builds.mjs';
import {assetUrl,releaseRecord,repository as checkRepository} from '../lib/project-identity.mjs';
const root=path.resolve(import.meta.dirname,'..');

/** Consume an exact signed Runtime output, including an unpublished Actions artifact.
 * Published release assets provide the durable download after artifact expiry. */
export async function githubBuildInput({pin,output,work,environment=process.env,directory=root,download=buildInput}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||path.resolve(output)===path.resolve(work)||output.startsWith(work+path.sep)||work.startsWith(output+path.sep))throw Error('A GitHub build input requires a new output and separate absolute work directory.');
 if(!/^attestations\/[a-f0-9]{64}\.json$/.test(pin?.evidence?.path||'')||!/^[a-f0-9]{64}$/.test(pin.evidence.sha256||''))throw Error('A GitHub build input requires pinned public signed evidence.');
 const selected=path.join(directory,pin.evidence.path),base=fs.realpathSync(directory),file=fs.realpathSync(selected);
 if(!file.startsWith(base+path.sep)||!fs.statSync(file).isFile()||sha(file)!==pin.evidence.sha256)throw Error('GitHub input evidence differs from its declared source.');
 const {record,bundle}=JSON.parse(fs.readFileSync(file)),repository=checkRepository(JSON.parse(fs.readFileSync(path.join(directory,'projects.json'))).repository);
 releaseRecord(record,{project:record?.id,repository});
 if(pin.evidence.path!=='attestations/'+record.asset.sha256+'.json')throw Error('Input evidence filename differs from its signed archive.');
 const evidence=verifyBuildEvidence({record,repository,bundle});
 fs.mkdirSync(work,{recursive:true});
 const cache=path.join(work,'archives');fs.mkdirSync(cache,{recursive:true});
 let archive=path.join(cache,record.asset.sha256);
 const valid=()=>fs.statSync(archive,{throwIfNoEntry:false})?.isFile()&&fs.statSync(archive).size===record.asset.bytes&&sha(archive)===record.asset.sha256;
 if(!valid()){
  const token=environment.GH_TOKEN||environment.GITHUB_TOKEN,artifact=pin.artifact;
  let unpublished=false;
  if(artifact&&token){
   if(!Number.isSafeInteger(artifact.id)||artifact.id<=0||!/^[a-f0-9]{64}$/.test(artifact.sha256||'')||/[\r\n"]/.test(token))throw Error('Invalid pinned Actions artifact.');
   const api='https://api.github.com/repos/'+repository+'/actions/artifacts/'+artifact.id;
   // The credential is sent on stdin, never in command arguments or logs.
   const config='header = "Authorization: Bearer '+token+'"\nheader = "Accept: application/vnd.github+json"\n';
   const request=(url,args=[],options={})=>{
    try{return execFileSync('curl',['--config','-','--fail','--silent','--show-error','--location','--retry','2','--retry-all-errors','--retry-delay','1','--retry-max-time','600','--proto','=https','--proto-redir','=https','--connect-timeout','30','--max-time','600',...args,url],{input:config,env:environment,encoding:'utf8',maxBuffer:4<<20,...options});}
    catch{throw Error('Pinned GitHub input request failed.');}
   };
   let metadata;try{metadata=JSON.parse(request(api));}catch{metadata=null;}
   if(metadata){
   if(metadata.id!==artifact.id||metadata.digest!=='sha256:'+artifact.sha256||String(metadata.workflow_run?.id)!==String(record.build?.runId)||metadata.workflow_run?.head_sha!==record.build?.sourceRevision||metadata.name!==`runtime-${record.id}-${record.version}-${record.arch}`)throw Error('Actions artifact differs from its declared signed build.');
   if(!metadata.expired){
    const zip=path.join(cache,artifact.sha256+'.zip');
    if(!fs.existsSync(zip)||sha(zip)!==artifact.sha256)request(api+'/zip',['--output',zip]);
    if(sha(zip)!==artifact.sha256)throw Error('Actions artifact checksum differs.');
    const names=execFileSync('/usr/bin/unzip',['-Z1',zip],{encoding:'utf8',maxBuffer:4<<20}).trim().split('\n');
    if(names.some(name=>path.basename(name)!==name||name==='.'||name==='..')||names.filter(name=>name===record.asset.filename).length!==1)throw Error('Actions artifact has unsafe or ambiguous input members.');
    const fd=fs.openSync(archive,'w',0o600);
    try{execFileSync('/usr/bin/unzip',['-p',zip,record.asset.filename],{stdio:['ignore',fd,'pipe']});}finally{fs.closeSync(fd);}
    if(!valid())throw Error('GitHub input archive differs from its signed build.');
    fs.unlinkSync(zip);unpublished=true;
   }
   }
  }
  if(!unpublished)archive=await download({url:assetUrl(record,repository),sha256:record.asset.sha256,bytes:record.asset.bytes},cache);
 }
 const checked=await verify({archive,sha256:record.asset.sha256,project:record.id,version:record.version,arch:record.arch,includeDeclaration:true});
 for(const key of ['manifestRelative','manifestSha256','sourceSha256','minimumMacOS','launcherArchitectures'])if(JSON.stringify(checked.declaration[key])!==JSON.stringify(record[key]))throw Error('GitHub input inventory differs from its signed record: '+key);
 fs.mkdirSync(output,{recursive:true});
 try{
  execFileSync('/usr/bin/tar',['-xzf',archive,'-C',output]);
  fs.renameSync(path.join(output,'files'),path.join(output,'payload'));
  fs.renameSync(path.join(output,'runtime-package.json'),path.join(output,'declaration.json'));
  return {root:path.join(output,'payload'),declaration:checked.declaration,record,evidence};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
