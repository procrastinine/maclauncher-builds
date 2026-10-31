import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {materializeImageDataInputs} from './android-image-data-input.mjs';
import {buildImageDataTool} from './build-android-image-data.mjs';
import {run} from './build-source.mjs';
const read=(program,args,options={})=>execFileSync(program,args,{encoding:'utf8',timeout:120000,...options}).trim();
function attach(image,mount,readOnly=false){
 const text=read('/usr/sbin/diskutil',['image','attach',...(readOnly?['--readOnly']:[]),...(mount?['--nobrowse','--mountPoint',mount]:['--noMount']),image]);
 const device=text.split(/\s+/).find(value=>/^\/dev\/disk\d+$/.test(value));if(!device)throw Error('The original image attachment has no device.');return device;
}

/** Restore verified Linux data on the original case-sensitive Mac image boundary. */
export async function prepareArtOriginalImage({inputs,elf,work}){
 if(process.platform!=='darwin'||process.arch!=='arm64'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(elf?.build?.fetched||''))throw Error('ART image restoration needs verified data inputs, its owned host context and a new Mac work directory.');
 fs.mkdirSync(work,{recursive:true});
 const union=await materializeImageDataInputs({inputs,output:path.join(work,'union')}),tool=buildImageDataTool({work:path.join(work,'tool')});
 const image=path.join(elf.build.fetched,'android16-image.dmg'),mount=path.join(elf.build.fetched,'android16-image'),sparse=path.join(work,'android16-source.dmg');
 if(fs.existsSync(image)||fs.existsSync(mount))throw Error('The ART image output already exists.');
 fs.mkdirSync(mount);let device;
 try{
  run('/usr/sbin/diskutil',['image','create','blank','--format','ASIF','--fs','None','--size','32g',sparse],{timeout:120000});
  device=attach(sparse);
  try{run('/sbin/newfs_apfs',['-e','-v','aim-system',device.replace('/dev/disk','/dev/rdisk')],{timeout:120000});}finally{run('/usr/sbin/diskutil',['eject',device],{timeout:120000});device=null;}
  device=attach(sparse,mount);
  run(tool.executable,['restore',union.root,path.join(mount,'root')],{timeout:900000});
  if(fs.readFileSync(path.join(mount,'root.identity'),'utf8').trim()!==union.profile.archive.sha256)throw Error('Restored ART image differs from its original archive identity.');
  run(path.join(elf.build.target,'release/linux-translate'),['--image',mount],{timeout:1800000});
  run('/usr/sbin/diskutil',['eject',device],{timeout:120000});device=null;
  run('/usr/sbin/diskutil',['image','create','from','--format','UDRO',sparse,image],{timeout:1800000});fs.unlinkSync(sparse);
  device=attach(image,mount,true);
  const attached=device;device=null;
  return {root:path.join(mount,'root'),mount,image,content:union.content,originalImage:{archiveSha256:union.profile.archive.sha256,content:union.content},detach:()=>run('/usr/sbin/diskutil',['eject',attached],{timeout:120000})};
 }catch(error){if(device)run('/usr/sbin/diskutil',['eject',device],{timeout:120000});throw error;}
}
