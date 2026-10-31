import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {checkoutSource,sourceNotices,run,recipeMain} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {rustEnvironment,rustNotices} from './rust-build.mjs';
import {helperPackage,sha} from './helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..');
const producer=path.join(root,'producers/android-image-data');
const descriptor=path.join(producer,'source.json');

/** Compile the data-only decoder facade or its macOS metadata restoration command. */
export function buildImageDataTool({work}){
 const profile=JSON.parse(fs.readFileSync(descriptor));
 const upstream=checkoutSource({repository:profile.repository,revision:profile.revision,destination:path.join(work,'upstream')});
 const crate=path.join(work,'crate');fs.mkdirSync(crate);
 for(const name of ['Cargo.toml','main.rs','tree.rs'])fs.copyFileSync(path.join(producer,name),path.join(crate,name));
 // Both the parser dependency and image orchestration use the exact untouched
 // upstream tree. Its materializer is replaced by the owned crate's module.
 fs.symlinkSync(upstream,path.join(crate,'upstream'),'dir');
 fs.mkdirSync(path.join(crate,'src'));fs.renameSync(path.join(crate,'main.rs'),path.join(crate,'src/main.rs'));fs.renameSync(path.join(crate,'tree.rs'),path.join(crate,'src/tree.rs'));
 fs.symlinkSync(upstream,path.join(crate,'src/upstream'),'dir');
 fs.copyFileSync(path.join(upstream,'Cargo.lock'),path.join(crate,'Cargo.lock'));
 const env={...rustEnvironment({work,minimumMacOS:'13.0',env:{...process.env,CARGO_HOME:path.join(work,'cargo')}}),CARGO_BUILD_JOBS:'2'};
 run('cargo',['fetch','--manifest-path',path.join(crate,'Cargo.toml')],{env});
 const packages=text=>text.split(/^\[\[package\]\]\s*$/m).slice(1).map(block=>Object.fromEntries([...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"$/gm)].map(match=>[match[1],match[2]])));
 const original=packages(fs.readFileSync(path.join(upstream,'Cargo.lock'),'utf8'));
 for(const item of packages(fs.readFileSync(path.join(crate,'Cargo.lock'),'utf8')).filter(item=>item.source))if(!original.some(row=>['name','version','source','checksum'].every(key=>row[key]===item[key])))throw Error('Image transport resolved a dependency outside the original lock: '+item.name);
 run('cargo',['build','--offline','--locked','--release','--jobs','2','--manifest-path',path.join(crate,'Cargo.toml')],{env});
 return {executable:path.join(env.CARGO_TARGET_DIR,'release/maclauncher-android-image-data'),upstream,crate,env};
}
/** The selected Mac materializer's content identity, independent of Linux link modes. */
export function imageDataContentIdentity(transport,{targetSymlinkMode=0o755}={}){
 const byName=new Map(),children=new Map();
 for(const row of transport.records){
  const bytes=Buffer.from(row.path),name=bytes.toString('utf8');
  if(!Buffer.from(name,'utf8').equals(bytes)||name.startsWith('/')||name.includes('\0')||name&&name.split('/').some(part=>!part||part==='.'||part==='..')||byName.has(name))throw Error('Invalid or duplicate image transport path.');
  if(!['directory','file','hardlink','symlink'].includes(row.kind))throw Error('Invalid image transport object.');
  byName.set(name,row);
  if(name){const parent=name.includes('/')?name.slice(0,name.lastIndexOf('/')):'';const list=children.get(parent)||[];list.push(name);children.set(parent,list);}
 }
 if(byName.get('')?.kind!=='directory')throw Error('Missing original image root.');
 for(const [parent]of children)if(byName.get(parent)?.kind!=='directory')throw Error('Image transport parent is not a directory.');
 const hash=crypto.createHash('sha256');let records=0,bytes=0;
 function regular(row,seen=new Set()){
  if(seen.has(row))throw Error('Cyclic image hardlink.');seen.add(row);
  if(row.kind==='file')return row;
  const linked=byName.get(Buffer.from(row.link||[]).toString('utf8'));
  if(row.kind!=='hardlink'||!linked)throw Error('Invalid image hardlink.');return regular(linked,seen);
 }
 function visit(name){
  const row=byName.get(name);let value;
  if(row.kind==='directory')value=[name,'directory',row.mode&0o777];
  else if(row.kind==='symlink')value=[name,'link',targetSymlinkMode,Buffer.from(row.link).toString('utf8')];
  else{const source=regular(row);if(!Number.isSafeInteger(source.size)||source.size<0||!(/^[a-f0-9]{64}$/).test(source.sha256||''))throw Error('Invalid image data identity.');value=[name,'file',row.mode&0o777,source.size,source.sha256];bytes+=source.size;}
  hash.update(JSON.stringify(value)+'\n');records++;
  if(row.kind==='directory')for(const child of (children.get(name)||[]).sort())visit(child);
 }
 visit('');return {sha256:hash.digest('hex'),records,bytes};
}
/** Split large data members while retaining their complete source-file identity. */
export function chunkImageData(transport,payload,chunkBytes){
 if(chunkBytes!==128*1024*1024)throw Error('Select the declared image data chunk size.');
 for(const row of transport.records.filter(row=>row.kind==='file'&&!row.chunks?.length&&row.size>chunkBytes)){
  if(!(/^\d{8}$/).test(row.data||''))throw Error('Invalid image data object name.');
  const input=path.join(payload,'data',row.data),fd=fs.openSync(input,'r'),whole=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(4*1024*1024),chunks=[];let consumed=0;
  try{
   while(consumed<row.size){
    const name=row.data+'-'+String(chunks.length).padStart(4,'0'),file=path.join(payload,'data',name),out=fs.openSync(file,'wx',0o644),hash=crypto.createHash('sha256');let size=0;
    try{while(size<chunkBytes&&consumed<row.size){const length=Math.min(buffer.length,chunkBytes-size,row.size-consumed),count=fs.readSync(fd,buffer,0,length,null);if(!count)throw Error('Truncated image data object.');const bytes=buffer.subarray(0,count);hash.update(bytes);whole.update(bytes);let written=0;while(written<count)written+=fs.writeSync(out,bytes,written,count-written);size+=count;consumed+=count;}}finally{fs.closeSync(out);}
    chunks.push({data:name,size,sha256:hash.digest('hex')});
   }
   if(fs.fstatSync(fd).size!==consumed||whole.digest('hex')!==row.sha256)throw Error('Image data differs from its complete decoder identity.');
  }finally{fs.closeSync(fd);}
  row.chunks=chunks;fs.unlinkSync(input);
 }
 return transport;
}

/** Balance immutable objects across the five declared ordinary input packages. */
export function planImageDataShards(transport,profiles){
 const shards=profiles.map(profile=>({...profile,bytes:0,objects:[]}));
 const objects=transport.records.filter(row=>row.kind==='file').flatMap(row=>row.chunks?.length?row.chunks:[{data:row.data,size:row.size,sha256:row.sha256}]);
 const seen=new Set();for(const object of objects){if(!(/^\d{8}(?:-\d{4})?$/).test(object.data||'')||seen.has(object.data)||!Number.isSafeInteger(object.size)||object.size<0||object.size>128*1024*1024||!(/^[a-f0-9]{64}$/).test(object.sha256||''))throw Error('Invalid image data shard object.');seen.add(object.data);}
 objects.sort((a,b)=>b.size-a.size||(a.data<b.data?-1:a.data>b.data?1:0));
 for(const object of objects){const selected=shards.reduce((a,b)=>a.bytes<=b.bytes?a:b);selected.objects.push(object);selected.bytes+=object.size;}
 for(const shard of shards){if(shard.bytes>850*1024*1024)throw Error('Original image shard exceeds its declared data budget.');shard.objects.sort((a,b)=>a.data<b.data?-1:a.data>b.data?1:0);}
 return shards;
}

/** Seal a completed original-parser export through the normal helper contract. */
export async function packageImageData({project,version,arch,output,work,tool,input}){
 const profile=JSON.parse(fs.readFileSync(descriptor)),selected=profile.profiles.find(row=>row.id===project),payload=path.join(output,'payload');
 if(!selected||version!==selected.version)throw Error('Select a declared original image data shard.');
 if(fs.existsSync(output))throw Error('Image data shard output already exists.');
 if(execFileSync('git',['-C',tool.upstream,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==profile.revision||execFileSync('git',['-C',tool.upstream,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Original image parser differs from its declared clean source.');
 const transport=JSON.parse(fs.readFileSync(path.join(input,'image-data.json')));
 if(transport.archive_sha256!==profile.archive.sha256||transport.source_revision!==profile.revision||profile.targetSymlinkMode!==0o755)throw Error('Image transport differs from its declared original.');
 const content=imageDataContentIdentity(transport,{targetSymlinkMode:profile.targetSymlinkMode});
 if(['sha256','records','bytes'].some(key=>content[key]!==profile.content[key]))throw Error('Decoded Android image content differs from the selected original ABI.');
 chunkImageData(transport,input,profile.chunkBytes);
 transport.shards=planImageDataShards(transport,profile.profiles);
 const shard=transport.shards.find(row=>row.id===project);
 fs.writeFileSync(path.join(input,'image-data.json'),JSON.stringify(transport)+'\n');
 fs.mkdirSync(path.join(payload,'data'),{recursive:true});
 for(const object of shard.objects)fs.copyFileSync(path.join(input,'data',object.data),path.join(payload,'data',object.data),fs.constants.COPYFILE_FICLONE);
 fs.copyFileSync(path.join(input,'image-data.json'),path.join(payload,'image-data.json'));
 fs.writeFileSync(path.join(payload,'content.json'),JSON.stringify(content)+'\n');
 const notices=sourceNotices(tool.upstream,{name:'AIM image parser',repository:profile.repository});
 const rust=rustNotices({source:tool.crate,output:path.join(work,'rust-notices'),env:tool.env});
 const records=[];
 for(const [index,notice]of [...notices,...rust].entries()){
  const relative='notices/'+index+'-'+path.basename(notice.file);fs.mkdirSync(path.dirname(path.join(payload,relative)),{recursive:true});fs.copyFileSync(notice.file,path.join(payload,relative));
  const {file,...metadata}=notice;records.push({...metadata,path:relative});
 }
 const license=await buildInput(profile.license,path.join(work,'archive-cache'));fs.copyFileSync(license,path.join(payload,'notices/android-sdk-arm-dbt-license.txt'));
 records.push({name:'Android SDK system image',license:'Android SDK ARM DBT license',path:'notices/android-sdk-arm-dbt-license.txt',sourceUrl:profile.license.url});
 const result=helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:{format:'android-image-data-v1',upstreamRevision:profile.revision,originalArchiveSha256:profile.archive.sha256,targetSymlinkMode:profile.targetSymlinkMode,content,transportSha256:sha(path.join(payload,'image-data.json')),dataShard:shard},notices:records});
 // Sealing computes actual data-object digests. Match those to the decoder's
 // records, so the target identity authenticates the delivered bytes as well.
 const inventory=new Map(JSON.parse(fs.readFileSync(path.join(output,'declaration.json'))).files.map(file=>[file.path,file]));
 for(const object of shard.objects){const file=inventory.get('data/'+object.data);if(!file||file.size!==object.size||file.sha256!==object.sha256)throw Error('Sealed image shard differs from its original decoder index.');}
 return result;
}
/** Decode the complete original image into portable data and exact inode metadata. */
export async function buildAndroidImageData(options){
 const {output,work}=options,profile=JSON.parse(fs.readFileSync(descriptor));
 fs.mkdirSync(work,{recursive:true});
 const archive=await buildInput(profile.archive,path.join(work,'archive-cache')),tool=buildImageDataTool({work});
 const input=path.join(work,'decoded');
 run(tool.executable,['export',archive,path.join(work,'root'),input],{env:tool.env});
 const result=await packageImageData({...options,tool,input});
 for(const relative of ['archive-cache','target','cargo','rust-notices','decoded'])fs.rmSync(path.join(work,relative),{recursive:true,force:true});
 return result;
}
recipeMain(import.meta,buildAndroidImageData);
