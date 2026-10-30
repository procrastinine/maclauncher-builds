import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sha} from './helper-package.mjs';
/** Fetch a declared public build input once; cached bytes always need its checksum. */
export async function buildInput({url,sha256,bytes,headers={}},cache=path.join(os.tmpdir(),'maclauncher-build-inputs')){
 if(!/^https:\/\//.test(url||'')||!(/^[a-f0-9]{64}$/).test(sha256||'')||bytes!==undefined&&(!Number.isSafeInteger(bytes)||bytes<=0))throw Error('A public build input needs an HTTPS URL and SHA-256.');
 fs.mkdirSync(cache,{recursive:true});const target=path.join(cache,sha256),valid=file=>fs.existsSync(file)&&(!bytes||fs.statSync(file).size===bytes)&&sha(file)===sha256;
 if(valid(target))return target;
 const temporary=path.join(cache,'.download-'+crypto.randomUUID());
 try {const response=await fetch(url,{headers,signal:AbortSignal.timeout(600000)});
  if(response.status===406){
   // Some archive endpoints reject Node's HTTP content negotiation. The
   // alternate transport uses the same declared URL and checksum below.
   await response.body?.cancel();
   await promisify(execFile)('curl',['--fail','--location','--retry','2','--proto','=https','--proto-redir','=https','--connect-timeout','30','--max-time','600',...Object.entries(headers).flatMap(([name,value])=>['--header',name+': '+value]),'--output',temporary,url],{timeout:610000});
  }else{
   if(!response.ok)throw Error('Build input returned HTTP '+response.status+': '+url);
   await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(temporary,{flags:'wx'}));
  }
  if(!valid(temporary))throw Error('Build input checksum or size differs: '+url);
  fs.renameSync(temporary,target);return target;
 }finally{fs.rmSync(temporary,{force:true});}
}
