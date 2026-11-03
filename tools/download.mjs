import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';

const attempts=5;
const transientCodes=new Set([5,6,7,16,18,28,52,55,56,92,95]);
export function transientDownload(error){
 const status=Number(String(error.stdout||'').trim());
 return error.code==='ETIMEDOUT'||error.killed===true||transientCodes.has(Number(error.code??error.status))||
  (Number(error.code??error.status)===22&&(status===408||status===429||status>=500&&status<=599));
}
function request(url,output,{headers={},config='',environment=process.env,bytes}={}){
 const protocol=new URL(url).protocol;
 if(protocol!=='https:')throw Error('A download needs an HTTPS URL.');
 // Keep HTTPS redirects on HTTPS, and credentials out of command arguments.
 const args=['--config','-','--fail','--silent','--show-error','--location','--proto','=https',
  '--proto-redir','=https','--connect-timeout','20','--speed-limit','1024','--speed-time','60',
  ...(bytes?['--max-filesize',String(bytes)]:[]),'--output',output,'--write-out','%{http_code}',url];
 for(const [name,value] of Object.entries(headers)){
  if(/[\r\n]/.test(name+value))throw Error('Invalid download header.');
  config+='header = '+JSON.stringify(name+': '+value)+'\n';
 }
 return {args,options:{input:config,env:environment,encoding:'utf8',maxBuffer:4<<20}};
}
/** Five transient-only attempts, including response bodies, with stall detection.
 * Identity checks belong to callers, outside this transport retry boundary. */
export async function downloadFile(url,output,{run=execFile,wait=sleep,...options}={}){
 for(let index=0;;index++){
  const {args,options:runOptions}=request(url,output,options);
  try{
   // execFile's asynchronous API has no input option; send curl configuration
   // on stdin explicitly, also when the response body is streamed to disk.
   await new Promise((resolve,reject)=>{
    const child=run('curl',args,runOptions,(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve());
    child.stdin.on('error',()=>{});child.stdin.end(runOptions.input);
   });
   return output;
  }catch(error){
   fs.rmSync(output,{force:true});
   const delay=1000*2**index;
   if(index+1>=attempts||!transientDownload(error))throw error;
   await wait(delay);
  }
 }
}
const pause=milliseconds=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);
export function downloadFileSync(url,output,{run=execFileSync,wait=pause,...options}={}){
 for(let index=0;;index++){
  const {args,options:runOptions}=request(url,output,options);
  try{run('curl',args,runOptions);return output;}
  catch(error){
   fs.rmSync(output,{force:true});
   const delay=1000*2**index;
   if(index+1>=attempts||!transientDownload(error))throw error;
   wait(delay);
  }
 }
}
/** Five attempts of one repeatable network step, such as a shallow fetch or a submodule
 * initialization, with the download backoff. Git has no reliable transient status, so
 * every failure is repeated and the last one is reported. */
export function retryNetwork(step,{wait=pause}={}){
 for(let index=0;;index++){
  try{return step();}
  catch(error){
   if(index+1>=attempts)throw error;
   wait(1000*2**index);
  }
 }
}
export async function downloadBytes(url,options){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'build-download-'));
 try{const file=await downloadFile(url,path.join(directory,'input'),options);return fs.readFileSync(file);}
 finally{fs.rmSync(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename){
 if(process.argv.length!==4){console.error('Use download.mjs <url> <output>.');process.exitCode=1;}
 else downloadFile(process.argv[2],process.argv[3]).catch(error=>{console.error(error.message);process.exitCode=1;});
}
