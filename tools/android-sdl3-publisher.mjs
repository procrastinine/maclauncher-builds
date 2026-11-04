import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const read=(command,args)=>execFileSync(command,args,{encoding:'utf8',maxBuffer:Infinity}).trim();
const isMounted=mount=>{try{return fs.statSync(mount).dev!==fs.statSync(path.dirname(mount)).dev;}catch{return false;}};

/** Extract only the selected original SDL framework from a read-only volume. */
export async function prepareSdl(archive,work,profile){
 const image=path.join(work,'SDL3.dmg');fs.copyFileSync(archive,image,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
 const mount=path.join(work,'sdl-volume');fs.mkdirSync(mount);
 const methods=[{attach:['/usr/sbin/diskutil',['image','attach','--readOnly','--nobrowse','--mountPoint',mount,image]],detach:['/usr/sbin/diskutil',['eject',mount]]},{attach:['/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,image]],detach:['/usr/bin/hdiutil',['detach',mount]]}];
 let selected,attached=false;
 try{
  for(const [index,method] of methods.entries()){
   selected=method;
   try{await execute(...method.attach,{timeout:60000,maxBuffer:Infinity});attached=true;break;}
   catch(error){if(isMounted(mount)){attached=true;break;}if(index===methods.length-1)throw error;}
  }
  if(!attached)throw Error('SDL disk image did not mount.');
  let level=[mount];const matches=[];
  while(level.length){
   const next=[];
   for(const directory of level)for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.name.startsWith('.')||entry.isSymbolicLink()||!entry.isDirectory())continue;
    const file=path.join(directory,entry.name);
    if(file.endsWith(profile.frameworkSuffix))matches.push(file);
    else next.push(file);
   }
   level=next;
  }
  if(matches.length!==1)throw Error('The publisher archive does not identify one SDL macOS framework.');
  const source=matches[0],sdl=path.join(work,'sdl','SDL3.framework');
  fs.mkdirSync(path.dirname(sdl),{recursive:true});fs.cpSync(source,sdl,{recursive:true,verbatimSymlinks:true});
  const version=read('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(sdl,'Resources/Info.plist')]);
  if(version!==profile.version)throw Error('The SDL framework differs from its declared publisher version.');
  return sdl;
 }finally{
  if(selected&&(attached||isMounted(mount)))await execute(...selected.detach,{timeout:30000,maxBuffer:Infinity});
  if(!isMounted(mount)){if(fs.existsSync(mount))fs.rmdirSync(mount);fs.rmSync(image,{force:true});}
 }
}
