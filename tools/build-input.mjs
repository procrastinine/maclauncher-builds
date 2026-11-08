import './producer-environment.mjs';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import {downloadFile} from './download.mjs';
import {sha} from './helper-package.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
/** Fetch a declared public build input once; cached bytes always need its checksum. */
export async function buildInput({url,sha256,bytes,headers={}},cache=path.join(os.tmpdir(),'maclauncher-build-inputs')){
 if(!/^https:\/\//.test(url||'')||!(/^[a-f0-9]{64}$/).test(sha256||'')||bytes!==undefined&&(!Number.isSafeInteger(bytes)||bytes<=0))throw Error('A public build input needs an HTTPS URL and SHA-256.');
 const own=/^https:\/\/github\.com\/[^/]+\/maclauncher-builds\/releases\/download\/([^/]+)\//.exec(url);
 if(own){const id=decodeURIComponent(own[1]).split('/v')[0],prepared=preparedBuildInput(id);if(prepared)return prepared.archive;if(process.env.BUILD_REPORTS)throw Error('The recipe did not resolve this Builds input before compilation: '+id);}
 fs.mkdirSync(cache,{recursive:true});const target=path.join(cache,sha256),valid=file=>fs.existsSync(file)&&(!bytes||fs.statSync(file).size===bytes)&&sha(file)===sha256;
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
