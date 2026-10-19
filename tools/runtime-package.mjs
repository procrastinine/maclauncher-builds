import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs');
const {validateDeclaration}=require('../lib/declaration.cjs');
const A=require('../lib/archive.cjs'),SHA=/^[a-f0-9]{64}$/;

export function publicDeclaration(value){
 validateDeclaration(value);
 if(value.redistribution==='local-only')throw Error('This package is restricted to local use.');
 const text=JSON.stringify(value);
 if(/(?:\/Users\/|\/home\/|file:\/\/|(?:password|accessToken|refreshToken|logPath|evidenceSource)"\s*:)/i.test(text))throw Error('Package metadata contains private paths or fields.');
 for(const file of value.files)A.safeFile(file.path);
 return value;
}

export async function pack({input,declaration,output}){
 declaration=publicDeclaration(declaration);input=fs.realpathSync(input);
 B.verifyPayload(input,declaration);
 const bytes=Buffer.from(JSON.stringify(declaration,null,2)+'\n');
 const entries=[{name:'runtime-package.json',bytes,size:bytes.length,sha256:B.digest(bytes),mode:0o644},
  ...declaration.files.map(file=>({...file,name:'files/'+file.path,file:path.join(input,file.path)}))];
 const archive=await A.writeArchive(entries,output);
 await verify({archive:output,sha256:archive.sha256});
 const record={schemaVersion:1,id:declaration.id,version:declaration.version,arch:declaration.arch,
  launcherArchitectures:declaration.launcherArchitectures,minimumMacOS:declaration.minimumMacOS,
  manifestRelative:declaration.manifestRelative,manifestSha256:declaration.manifestSha256,
  sourceSha256:declaration.sourceSha256,updatePolicy:'manual',
  asset:{filename:path.basename(output),sha256:archive.sha256,bytes:archive.bytes}};
 fs.writeFileSync(output+'.json',JSON.stringify(record,null,2)+'\n',{flag:'wx'});
 return record;
}

/** Validate downloads by streaming regular tar members; no extraction or guest
 * code execution is needed to reject traversal, links or extra payload files. */
export async function verify({archive,sha256}){
 if(!SHA.test(sha256||''))throw Error('An exact expected archive SHA-256 is required.');
 const stat=fs.lstatSync(archive);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>A.LIMITS.archiveBytes)throw Error('Invalid runtime archive file.');
 if(await A.checksum(archive)!==sha256)throw Error('Runtime archive checksum differs from the selected release.');
 const input=fs.createReadStream(archive),stream=zlib.createGunzip();input.on('error',error=>stream.destroy(error));input.pipe(stream);
 const reader=new A.ArchiveReader(stream),seen=new Set();let declaration,expected,total=0;
 try{
  while(true){
   const header=await reader.read(512);
   if(header.every(byte=>byte===0)){if(!(await reader.read(512)).every(byte=>byte===0))throw Error('Invalid archive terminator.');await reader.end();break;}
   const entry=A.parseHeader(header);if(seen.has(entry.name)||seen.size>=B.LIMITS.files+1)throw Error('Duplicate or excessive archive members.');seen.add(entry.name);
   total+=entry.size;if(total>A.LIMITS.expandedBytes)throw Error('Runtime archive exceeds its expanded size limit.');
   if(!declaration){
    if(entry.name!=='runtime-package.json'||entry.mode!==0o644||entry.size>A.LIMITS.metadataBytes)throw Error('Runtime inventory must be the first archive member.');
    declaration=publicDeclaration(JSON.parse((await reader.read(entry.size)).toString('utf8')));
    expected=new Map(declaration.files.map(file=>['files/'+file.path,file]));
   }else{
    const file=expected.get(entry.name);
    if(!file||file.size!==entry.size||file.mode!==entry.mode)throw Error('Runtime archive member differs from its inventory.');
    const hash=crypto.createHash('sha256');let left=entry.size;
    while(left){const chunk=await reader.read(Math.min(left,65536));left-=chunk.length;hash.update(chunk);}
    if(hash.digest('hex')!==file.sha256)throw Error('Runtime file checksum differs from its inventory.');
   }
   if(entry.size%512&&(await reader.read(512-entry.size%512)).some(byte=>byte!==0))throw Error('Invalid archive padding.');
  }
  if(!declaration||[...expected.keys()].some(file=>!seen.has(file)))throw Error('Runtime archive is missing declared files.');
  return {id:declaration.id,version:declaration.version,arch:declaration.arch,files:expected.size,sha256};
 }finally{input.destroy();stream.destroy();}
}

export function catalog(records,{repository}={}){
 if(repository&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw Error('Use an explicit GitHub owner/repository.');
 const seen=new Set();const packages=records.map(record=>{
  const key=[record.id,record.version,record.arch].join('/');
  if(record.schemaVersion!==1||record.updatePolicy!=='manual'||seen.has(key)||
   !/^[a-z0-9-]+$/.test(record.id||'')||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.version||'')||
   !['arm64','x64','universal'].includes(record.arch)||!/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(record.minimumMacOS||'')||
   !Array.isArray(record.launcherArchitectures)||!record.launcherArchitectures.length||
   record.launcherArchitectures.some(arch=>!['arm64','x64'].includes(arch))||
   !SHA.test(record.manifestSha256||'')||!SHA.test(record.sourceSha256||'')||
   !SHA.test(record.asset?.sha256||'')||!Number.isSafeInteger(record.asset.bytes)||record.asset.bytes<1||record.asset.bytes>A.LIMITS.archiveBytes||
   !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.asset.filename||''))throw Error('Invalid or duplicate runtime release record.');
  A.safeFile(record.manifestRelative);
  publicMetadata(record);
  seen.add(key);const tag=[record.id,record.version,record.arch].join('-');
  return {...record,...(repository?{tag,asset:{...record.asset,url:`https://github.com/${repository}/releases/download/${tag}/${record.asset.filename}`}}:{})};
 });
 return {schemaVersion:1,updatePolicy:'manual',packages};
}

function publicMetadata(value){if(/(?:\/Users\/|\/home\/|file:\/\/|(?:password|accessToken|refreshToken|logPath|evidenceSource)"\s*:)/i.test(JSON.stringify(value)))throw Error('Package metadata contains private paths or fields.');}

function argumentsFor(args){const options={};for(let n=0;n<args.length;n+=2){if(!args[n].startsWith('--')||!args[n+1])throw Error('Expected --option value pairs.');const name=args[n].slice(2);if(name==='package')(options.packages||=[]).push(args[n+1]);else if(Object.hasOwn(options,name))throw Error('Duplicate option: '+name);else options[name]=args[n+1];}return options;}
export async function main([command,...args]){
 const o=argumentsFor(args);
 const allowed={pack:['input','declaration','output','id'],verify:['archive','sha256'],catalog:['packages','repository','output']}[command];
 if(!allowed)throw Error('Use pack, verify or catalog.');
 for(const key of Object.keys(o))if(!allowed.includes(key))throw Error('Unknown option: '+key);
 if(command==='pack'){
  if(!o.input||!o.declaration||!o.output)throw Error('pack requires --input, --declaration and --output.');
  let declaration=JSON.parse(fs.readFileSync(o.declaration));
  if(Array.isArray(declaration)){const matches=declaration.filter(item=>!o.id||item.id===o.id);if(matches.length!==1)throw Error('Select one package with --id.');declaration=matches[0];}
  return pack({input:o.input,declaration,output:o.output});
 }
 if(command==='verify')return verify({archive:o.archive,sha256:o.sha256});
 if(command==='catalog'){
  if(!o.packages?.length||!o.output)throw Error('catalog requires --package records and --output.');
  const result=catalog(o.packages.map(file=>JSON.parse(fs.readFileSync(file))),{repository:o.repository});
  fs.writeFileSync(o.output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
 }
 throw Error('Use pack, verify or catalog.');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
