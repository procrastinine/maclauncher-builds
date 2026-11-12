// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname;
/** Sign the actual NGX core after stripping; retain only the public certificate. */
export function signNgx({work,output,mingw,osslsigncode,openssl='openssl'}){
 const directory=path.join(work,'ngx-signing'),certificate=path.join(directory,'certificate.pem'),key=path.join(directory,'key.pem');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const run=(program,args)=>execFileSync(program,args,{stdio:['ignore','pipe','pipe']});
 const core=path.join(output,'x64/nvngx.dll'),signed=path.join(directory,'nvngx.dll');
 try {
  run(openssl,['req','-x509','-newkey','rsa:3072','-nodes','-keyout',key,'-out',certificate,'-days','3650','-subj','/CN=MacLauncher NGX',
   '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,digitalSignature,keyCertSign','-addext','extendedKeyUsage=codeSigning','-addext','subjectAltName=URI:https://github.com/procrastinine/maclauncher-builds/ngx']);
  fs.chmodSync(key,0o600);
  run(osslsigncode,['sign','-certs',certificate,'-key',key,'-n','MacLauncher NGX','-h','sha256','-in',core,'-out',signed]);
  run(osslsigncode,['verify','-CAfile',certificate,'-in',signed]);
  fs.renameSync(signed,core);
  const certDir=path.join(output,'ngx-signing');fs.mkdirSync(certDir,{recursive:true});
  run(openssl,['x509','-in',certificate,'-outform','DER','-out',path.join(certDir,'certificate.der')]);
  const helper=path.join(output,'x64/ngx-trust.exe');
  run(path.join(mingw,'x86_64-w64-mingw32-clang'),['-O2','-municode','-static','-ffile-prefix-map='+here+'=vkd3d-proton',
   '-Wl,--no-insert-timestamp',path.join(here,'ngx-trust.c'),'-lwintrust','-lcrypt32','-o',helper]);
  run(path.join(mingw,'llvm-strip'),['--strip-debug',helper]);
  return {certificate:'ngx-signing/certificate.der',helper:'x64/ngx-trust.exe'};
 } finally { fs.rmSync(key,{force:true}); }
}
