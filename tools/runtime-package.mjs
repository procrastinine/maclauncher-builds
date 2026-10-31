import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {assetName,releaseTag,assetUrl,identity,projectId,releaseRecord,validateCatalog} from '../lib/project-identity.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recordMetadata} from '../lib/record-metadata.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs');
const {validateDeclaration}=require('../lib/declaration.cjs');
const A=require('../lib/archive.cjs'),SHA=/^[a-f0-9]{64}$/;

export function publicDeclaration(value){
 validateDeclaration(value);
 if(value.redistribution==='local-only')throw Error('This package is restricted to local use.');
 const text=JSON.stringify(value);
 if(/(?:"(?:\/Users\/|\/home\/)|file:\/\/|(?:password|accessToken|refreshToken|logPath|evidenceSource)"\s*:)/i.test(text))throw Error('Package metadata contains private paths or fields.');
 for(const file of value.files)A.safeFile(file.path);
 return value;
}

export async function pack({project,input,declaration,output,metadata={},sourceDateEpoch=0}){
 projectId(project);declaration=publicDeclaration(declaration);identity(declaration);
 if(declaration.id!==project)throw Error(`Package belongs to ${declaration.id}; expected project ${project}.`);
 if(path.basename(output)!==assetName(declaration))throw Error('Output filename must be '+assetName(declaration));
 input=fs.realpathSync(input);
 B.verifyPayload(input,declaration);
 const manifest=JSON.parse(B.readRegular(path.join(input,declaration.manifestRelative),B.LIMITS.manifestBytes).bytes);
 const publication=recordMetadata({project,manifest,metadata});
 const bytes=Buffer.from(JSON.stringify(declaration,null,2)+'\n');
 const entries=[{name:'runtime-package.json',bytes,size:bytes.length,sha256:B.digest(bytes),mode:0o644},
  ...declaration.files.map(file=>({...file,name:'files/'+file.path,file:path.join(input,file.path)}))];
 const archive=await A.writeArchive(entries,output,{sourceDateEpoch});
 await verify({archive:output,sha256:archive.sha256,project,version:declaration.version,arch:declaration.arch});
 const record={schemaVersion:2,id:declaration.id,version:declaration.version,arch:declaration.arch,
  launcherArchitectures:declaration.launcherArchitectures,minimumMacOS:declaration.minimumMacOS,
  manifestRelative:declaration.manifestRelative,manifestSha256:declaration.manifestSha256,
  sourceSha256:declaration.sourceSha256,updatePolicy:'manual',...publication,
  asset:{filename:path.basename(output),sha256:archive.sha256,bytes:archive.bytes}};
 fs.writeFileSync(output+'.json',JSON.stringify(record,null,2)+'\n',{flag:'wx'});
 return record;
}

/** Validate downloads by streaming regular tar members; no extraction or guest
 * code execution is needed to reject traversal, links or extra payload files. */
export async function verify({archive,sha256,project,version,arch,includeDeclaration=false,includeManifest=false}){
 identity({id:project,version,arch});
 if(!SHA.test(sha256||''))throw Error('An exact expected archive SHA-256 is required.');
 const stat=fs.lstatSync(archive);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>A.LIMITS.archiveBytes)throw Error('Invalid runtime archive file.');
 if(await A.checksum(archive)!==sha256)throw Error('Runtime archive checksum differs from the selected release.');
 const input=fs.createReadStream(archive),stream=zlib.createGunzip();input.on('error',error=>stream.destroy(error));input.pipe(stream);
 const reader=new A.ArchiveReader(stream),seen=new Set();let declaration,expected,manifest,total=0;
 try{
  while(true){
   const header=await reader.read(512);
   if(header.every(byte=>byte===0)){if(!(await reader.read(512)).every(byte=>byte===0))throw Error('Invalid archive terminator.');await reader.end();break;}
   const entry=A.parseHeader(header);if(seen.has(entry.name)||seen.size>=B.LIMITS.files+1)throw Error('Duplicate or excessive archive members.');seen.add(entry.name);
   total+=entry.size;if(total>A.LIMITS.expandedBytes)throw Error('Runtime archive exceeds its expanded size limit.');
   if(!declaration){
    if(entry.name!=='runtime-package.json'||entry.mode!==0o644||entry.size>A.LIMITS.metadataBytes)throw Error('Runtime inventory must be the first archive member.');
    declaration=publicDeclaration(JSON.parse((await reader.read(entry.size)).toString('utf8')));
    if(declaration.id!==project||declaration.version!==version||declaration.arch!==arch)throw Error('Runtime archive belongs to a different project, version or architecture.');
    expected=new Map(declaration.files.map(file=>['files/'+file.path,file]));
   }else{
    const file=expected.get(entry.name);
    if(!file||file.size!==entry.size||file.mode!==entry.mode)throw Error('Runtime archive member differs from its inventory.');
    const hash=crypto.createHash('sha256'),capture=includeManifest&&file.path===declaration.manifestRelative,chunks=[];let left=entry.size;
    if(capture&&entry.size>A.LIMITS.metadataBytes)throw Error('Runtime manifest exceeds its metadata limit.');
    while(left){const chunk=await reader.read(Math.min(left,65536));left-=chunk.length;hash.update(chunk);if(capture)chunks.push(chunk);}
    if(capture)manifest=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(hash.digest('hex')!==file.sha256)throw Error('Runtime file checksum differs from its inventory.');
   }
   if(entry.size%512&&(await reader.read(512-entry.size%512)).some(byte=>byte!==0))throw Error('Invalid archive padding.');
  }
  if(!declaration||[...expected.keys()].some(file=>!seen.has(file)))throw Error('Runtime archive is missing declared files.');
  return {id:declaration.id,version:declaration.version,arch:declaration.arch,files:expected.size,sha256,...(includeDeclaration?{declaration}:{}),...(includeManifest?{manifest}:{})};
 }finally{input.destroy();stream.destroy();}
}

export function catalog(records,{project,repository,previous}={}){
 projectId(project);if(!Array.isArray(records)||!records.length)throw Error('Select at least one project release record.');
 if(previous)validateCatalog(previous,{project,repository,allowEmpty:true});
 const seen=new Set(),old=new Map((previous?.packages||[]).map(record=>[record.version+'/'+record.arch,record]));
 const packages=records.map(record=>{
  releaseRecord(record,{project,repository});const key=record.version+'/'+record.arch;
  if(seen.has(key))throw Error('Duplicate project/version/architecture.');seen.add(key);
  const result={...record,tag:releaseTag(record),asset:{...record.asset,url:assetUrl(record,repository)}};
  if(old.has(key)&&!additiveRecordMetadata(old.get(key),result))throw Error('Published project versions are immutable; choose a new version.');
  return result;
 });
 for(const record of previous?.packages||[])if(!seen.has(record.version+'/'+record.arch))packages.push(record);
 return validateCatalog({schemaVersion:2,projectId:project,updatePolicy:'manual',packages},{project,repository});
}

// Published payload identities stay fixed; factual metadata can be backfilled.
function additiveRecordMetadata(previous,next){
 const {source:oldSource,capabilities:oldCapabilities,launcherContract:oldContract,build:oldBuild,rebuild:oldRebuild,...oldPayload}=previous;
 const {source:nextSource,capabilities:nextCapabilities,launcherContract:nextContract,build:nextBuild,rebuild:nextRebuild,...nextPayload}=next;
 if(oldBuild!==undefined&&stable(oldBuild)!==stable(nextBuild)||oldRebuild!==undefined&&stable(oldRebuild)!==stable(nextRebuild))return false;
 if(stable(oldPayload)!==stable(nextPayload))return false;
 if(oldSource!==undefined&&stable(oldSource)!==stable(nextSource))return false;
 if(oldContract===undefined?nextContract!==undefined&&nextContract!==1:oldContract!==nextContract)return false;
 if(oldCapabilities!==undefined&&(nextCapabilities===undefined||Object.entries(oldCapabilities).some(([key,value])=>
  !Object.hasOwn(nextCapabilities,key)||stable(value)!==stable(nextCapabilities[key]))))return false;
 return true;
}

function stable(value){return JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);}

function argumentsFor(args){const options={};for(let n=0;n<args.length;n+=2){if(!args[n].startsWith('--')||!args[n+1])throw Error('Expected --option value pairs.');const name=args[n].slice(2);if(name==='package')(options.packages||=[]).push(args[n+1]);else if(Object.hasOwn(options,name))throw Error('Duplicate option: '+name);else options[name]=args[n+1];}return options;}
export async function main([command,...args]){
 const o=argumentsFor(args);
 const allowed={pack:['project','input','declaration','output'],verify:['project','version','arch','archive','sha256'],catalog:['project','packages','output','previous']}[command];
 if(!allowed)throw Error('Use pack, verify or catalog.');
 for(const key of Object.keys(o))if(!allowed.includes(key))throw Error('Unknown option: '+key);
 const project=resolveProject(o.project);
 if(command==='pack'){
  if(!o.input||!o.declaration||!o.output)throw Error('pack requires --input, --declaration and --output.');
  let declaration=JSON.parse(fs.readFileSync(o.declaration));
  if(Array.isArray(declaration)){const matches=declaration.filter(item=>item.id===o.project);if(matches.length!==1)throw Error('Declaration does not contain exactly one selected project.');declaration=matches[0];}
  return pack({project:o.project,input:o.input,declaration,output:o.output});
 }
 if(command==='verify')return verify({archive:o.archive,sha256:o.sha256,project:o.project,version:o.version,arch:o.arch});
 if(command==='catalog'){
  if(!o.packages?.length||!o.output)throw Error('catalog requires --package records and --output.');
  if(path.basename(o.output)!==o.project+'.json')throw Error('Catalog filename must be '+o.project+'.json');
  const previous=o.previous?JSON.parse(fs.readFileSync(o.previous)):undefined;
  const result=catalog(o.packages.map(file=>JSON.parse(fs.readFileSync(file))),{project:o.project,repository:project.releaseRepository,previous});
  if(fs.existsSync(o.output)&&(!o.previous||path.resolve(o.previous)!==path.resolve(o.output)))throw Error('Use --previous to retain existing published versions.');
  fs.mkdirSync(path.dirname(path.resolve(o.output)),{recursive:true});
  const temporary=o.output+'.tmp-'+process.pid;try{fs.writeFileSync(temporary,JSON.stringify(result,null,2)+'\n',{flag:'wx'});fs.renameSync(temporary,o.output);}finally{fs.rmSync(temporary,{force:true});}return result;
 }
 throw Error('Use pack, verify or catalog.');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
