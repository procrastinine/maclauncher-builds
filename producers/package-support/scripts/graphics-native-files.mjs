import fs from 'node:fs';
import path from 'node:path';
import {appRequire} from '../../../tools/app-source.mjs';
const Native=appRequire('src/modules/shared/runtime/local-native.js');
const BinaryArch=appRequire('src/core/binary-arch.js');

export function nativeProviderArchitectures(file) {
 const fd=fs.openSync(file,'r');
 try {
  const bytes=Buffer.alloc(4);
  if(fs.readSync(fd,bytes,0,4,0)!==4||!BinaryArch.machoMagic(bytes.readUInt32BE(0)))return null;
 } finally { fs.closeSync(fd); }
 return Native.readMachOArchitectures(file,{allowLibrary:true});
}

/** Check both the declared executable contract and the actual native headers. */
export function verifyGraphicsExecutableModes(root,files) {
 let native=0,executables=0;
 for(const entry of files){
  const file=path.join(root,entry.path),stat=fs.statSync(file);
  if(entry.mode===0o755){executables++;if(!(stat.mode&0o111))throw Error('Declared graphics executable has no execute permission: '+entry.path);}
  if(nativeProviderArchitectures(file)){native++;if(entry.mode!==0o755)throw Error('Mach-O graphics file is not declared executable: '+entry.path);}
 }
 return {files:files.length,native,executables};
}
