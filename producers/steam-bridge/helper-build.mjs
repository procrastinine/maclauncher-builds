// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname;
export function buildHelpers({work,mingw,source,pins}) {
 const run=(file,args)=>execFileSync(path.join(mingw,file),args,{stdio:'inherit'});
 const shim=path.join(source,'programs/steam.exe');
 for(const [arch,target]of [['x86_64','x86_64'],['i386','i686']]){
  const dir=path.join(work,'helper-'+arch);fs.mkdirSync(dir,{recursive:true});
  const object=path.join(dir,'apc.o'),raw=path.join(dir,'apc.bin');
  run(target+'-w64-mingw32-clang',['-O2','-fno-stack-protector','-ffreestanding','-fno-builtin','-fno-jump-tables','-fno-unwind-tables','-fno-asynchronous-unwind-tables','-I'+here,'-c',path.join(here,'apc.c'),'-o',object]);
  const reloc=execFileSync(path.join(mingw,'llvm-readobj'),['--relocations',object],{encoding:'utf8'});
  if(/Section \(\d+\) \.text/.test(reloc))throw Error('Bootstrap code contains text relocations');
  // COFF objcopy does not guarantee a raw binary output. Read the section
  // bytes directly and reject fixups in the position-independent callback.
  const coff=fs.readFileSync(object),count=coff.readUInt16LE(2),first=20+coff.readUInt16LE(16);
  const sections=Array.from({length:count},(_,i)=>first+i*40).filter(o=>coff.subarray(o,o+8).toString().replace(/\0.*$/,'')==='.text'&&coff.readUInt32LE(o+16));
  if(sections.length!==1)throw Error('Bootstrap must have one code section');
  const section=sections[0],size=coff.readUInt32LE(section+16),offset=coff.readUInt32LE(section+20);
  if(coff.readUInt16LE(section+32)||offset+size>coff.length)throw Error('Bootstrap code needs relocation or exceeds its object');
  const bytes=coff.subarray(offset,offset+size);fs.writeFileSync(raw,bytes);
  fs.writeFileSync(path.join(dir,'apc-code.h'),'static const unsigned char bridge_apc_code[] = {'+[...bytes].join(',')+'};\n');
  run(target+'-w64-mingw32-clang',['-O2','-shared','-static','-Wl,--no-insert-timestamp',path.join(here,'loader.c'),'-o',path.join(dir,'mlsteam-bootstrap.dll')]);
  const pe=path.join(work,'build-x86_64');
  run(target+'-w64-mingw32-clang++',['-std=c++17','-O2','-DNOMINMAX',...(pins.helperLaunchHandshake?['-DSTEAM_BRIDGE_UPSTREAM_HANDSHAKE']:[]),'-municode','-D__WINESRC__','-DWINE_NO_LONG_TYPES','-DPATH_MAX=4096','-include',path.join(here,'helper-compat.h'),'-I'+dir,'-I'+here,'-I'+work,'-I'+shim,'-I'+path.join(shim,'proton-headers/steamworks_sdk_142'),'-I'+path.join(shim,'proton-headers/openvr/headers'),'-I'+path.join(shim,'proton-headers/wine/include'),'-idirafter',path.join(source,'include'),path.join(here,'helper-main.cpp'),path.join(here,'bootstrap-child.cpp'),'-static','-Wl,--no-insert-timestamp','-ladvapi32','-lshlwapi','-lshell32','-lmsi','-luser32',path.join(pe,'dlls/ntdll',arch+'-windows/libntdll.a'),path.join(pe,'dlls/kernel32',arch+'-windows/libkernel32.a'),'-o',path.join(dir,'steam.exe')]);
 }
}
