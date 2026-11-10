import './producer-environment.mjs';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import {downloadFile} from './download.mjs';
import {sha} from './helper-package.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {archiveInput} from '../lib/pins.mjs';
/** The declared llvm-mingw release archive for Windows-side libraries. */
export function llvmMingwInput(){return archiveInput(JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'../producers/dependencies/llvmMingw.json'))));}
/** Fetch a declared public build input once; cached bytes always need its checksum, a SHA-256 or, when the
 *  publisher states only that, a SHA-512. */
export async function buildInput({url,sha256,sha512,bytes,headers={}},cache=path.join(os.tmpdir(),'maclauncher-build-inputs')){
 const digest=sha256??sha512,algorithm=sha256===undefined?'sha512':'sha256';
 if(!/^https:\/\//.test(url||'')||!(sha256===undefined?/^[a-f0-9]{128}$/:/^[a-f0-9]{64}$/).test(digest||'')||bytes!==undefined&&(!Number.isSafeInteger(bytes)||bytes<=0))throw Error('A public build input needs an HTTPS URL and SHA-256 or SHA-512.');
 const own=/^https:\/\/github\.com\/[^/]+\/maclauncher-builds\/releases\/download\/([^/]+)\//.exec(url);
 if(own){const id=decodeURIComponent(own[1]).split('/v')[0],prepared=preparedBuildInput(id);if(prepared)return prepared.archive;if(process.env.BUILD_REPORTS)throw Error('The recipe did not resolve this Builds input before compilation: '+id);}
 fs.mkdirSync(cache,{recursive:true});const target=path.join(cache,digest),valid=file=>fs.existsSync(file)&&(!bytes||fs.statSync(file).size===bytes)&&(algorithm==='sha256'?sha(file):crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex'))===digest;
 if(valid(target))return target;
 const temporary=path.join(cache,'.download-'+crypto.randomUUID());
 try {
  // Stream with the system HTTP client. Node 24's bundled Undici can abort the
  // process when a peer closes a response while its body parser is paused.
  await downloadFile(url,temporary,{headers});
  if(!valid(temporary))throw Error('Build input checksum or size differs: '+url);
  fs.renameSync(temporary,target);return target;
 }finally{fs.rmSync(temporary,{force:true});}
}
