import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {assetName,identity} from '../lib/project-identity.mjs';
import {releaseVersion} from '../lib/package-version.mjs';
import {publicDeclaration,verify} from './runtime-package.mjs';
const require=createRequire(import.meta.url),A=require('../lib/archive.cjs');
const bytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

/** Rewrite the package and its consumed manifest without extracting or changing runtime files. */
export async function reversionPackage({archive,record,version,output,directory=path.resolve(import.meta.dirname,'..')}){
 releaseVersion(record.id,version,directory);
 if(version===record.version)throw Error('Repacking requires a new immutable release version.');
 identity({...record,version});
 if(path.basename(output)!==assetName({...record,version})||path.resolve(archive)===path.resolve(output)||fs.existsSync(output))throw Error('Choose a new archive path matching the package version.');
 const checked=await verify({archive,sha256:record.asset.sha256,project:record.id,version:record.version,arch:record.arch,includeDeclaration:true,includeManifest:true});
 if(!checked.manifest||checked.manifest.version!==record.version)throw Error('The consumed manifest differs from the original package version.');
 const manifest=bytes({...checked.manifest,version}),original=checked.declaration;
 const {sourceArtifact,...metadata}=original;
 const declaration=publicDeclaration({...metadata,version,directoryRelative:[record.id,version,record.arch].join('/'),sourceRelative:original.sourceRelative==null||original.sourceRelative===original.manifestRelative?null:original.sourceRelative,manifestSha256:digest(manifest),files:original.files.map(file=>file.path===original.manifestRelative?{...file,size:manifest.length,sha256:digest(manifest)}:file)});
 delete declaration.sourceArtifact;
 const replacements=new Map([['runtime-package.json',bytes(declaration)],['files/'+declaration.manifestRelative,manifest]]);
 const compressed=fs.createReadStream(archive),unzip=zlib.createGunzip(),originalHash=crypto.createHash('sha256');compressed.on('data',chunk=>originalHash.update(chunk));compressed.on('error',error=>unzip.destroy(error));compressed.pipe(unzip);const reader=new A.ArchiveReader(unzip);let started=false;
 async function* entries(){
  try{
   while(true){
    const header=await reader.read(512);
    if(header.every(byte=>byte===0)){if(!(await reader.read(512)).every(byte=>byte===0))throw Error('Invalid archive terminator.');await reader.end();if(originalHash.digest('hex')!==record.asset.sha256)throw Error('Original package changed while repacking.');yield Buffer.alloc(1024);break;}
    const entry=A.parseHeader(header),replacement=replacements.get(entry.name);
    yield replacement?A.tarHeader(entry.name,replacement.length,entry.mode):header;
    if(replacement)yield replacement;
    let left=entry.size;while(left){const chunk=await reader.read(Math.min(left,65536));left-=chunk.length;if(!replacement)yield chunk;}
    if(entry.size%512)await reader.read(512-entry.size%512);
    const length=replacement?.length??entry.size;if(length%512)yield Buffer.alloc(512-length%512);
   }
  }finally{compressed.destroy();unzip.destroy();}
 }
 try{
  fs.mkdirSync(path.dirname(output),{recursive:true});const target=fs.createWriteStream(output,{flags:'wx',mode:0o600});target.once('open',()=>{started=true;});
  await pipeline(Readable.from(entries()),zlib.createGzip({level:6}),target);
  const sha256=await A.checksum(output);await verify({archive:output,sha256,project:record.id,version,arch:record.arch});
  // A new archive has no attestation or comparison inherited from its input.
  const {tag,sourceAsset,build,rebuild,...previous}=record,result={...previous,version,manifestSha256:declaration.manifestSha256,asset:{filename:path.basename(output),sha256,bytes:fs.statSync(output).size}};
  fs.writeFileSync(output+'.json',bytes(result),{flag:'wx'});
  return{record:result,declaration,manifest:JSON.parse(manifest),unchangedFiles:original.files.filter(file=>file.path!==original.manifestRelative).length};
 }catch(error){if(started)fs.rmSync(output,{force:true});throw error;}
}
export async function main(args){
 const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['archive','record','version','output'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --archive, --record, --version and --output.');options[key]=args[i+1];}
 if(!options.archive||!options.record||!options.version||!options.output)throw Error('An archive, its record, a version and a new output path are required.');
 const result=await reversionPackage({...options,record:JSON.parse(fs.readFileSync(options.record))});return{id:result.record.id,version:result.record.version,archive:options.output,unchangedFiles:result.unchangedFiles};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
