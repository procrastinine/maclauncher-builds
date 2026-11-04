import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';

export const networkAttempts=6;
export const networkDelay=index=>5000*2**index;
const exhausted=Symbol('network retry exhausted');
const transientCodes=new Set([5,6,7,16,18,28,52,55,56,92,95]);
export function transientDownload(error){
 if(error?.[exhausted])return false;
 const message=[error.message,error.stderr,error.stdout,error.cause?.message].map(value=>String(value||'')).join('\n');
 const status=Number(error.statusCode||error.response?.status||(Number(error.status)>=400?error.status:null)||(/^\d{3}$/.test(String(error.stdout||'').trim())?String(error.stdout).trim():message.match(/(?:HTTP(?:\/\d(?:\.\d)?)?\s*|(?:status(?: code)?|returned error|response code)[:=]?\s*)([45]\d\d)\b/i)?.[1]));
 if(status>=400)return status===408||status===429||status>=500&&status<=599;
 return ['ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','EPIPE','ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)||error.killed===true||transientCodes.has(Number(error.code??error.status))||
  /TLS handshake timeout|connection (?:refused|reset|timed out|closed)|no such host|temporary failure in name resolution|could not resolve host|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network (?:error|unreachable)|read timeout|service unavailable|bad gateway|gateway timeout|too many requests|unexpected EOF|early EOF|RPC failed|fetch failed/i.test(message);
}
const pause=milliseconds=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);
export function retryNetwork(step,{wait=pause}={}){
 for(let index=0;;index++)try{return step();}catch(error){
  if(index+1>=networkAttempts||!transientDownload(error)){if(index+1>=networkAttempts)error[exhausted]=true;throw error;}
  wait(networkDelay(index));
 }
}
export async function retryNetworkAsync(step,{wait=sleep}={}){
 for(let index=0;;index++)try{return await step();}catch(error){
  if(index+1>=networkAttempts||!transientDownload(error)){if(index+1>=networkAttempts)error[exhausted]=true;throw error;}
  await wait(networkDelay(index));
 }
}

function request(url,output,{headers={},config='',environment=process.env}={}){
 const protocol=new URL(url).protocol;
 if(protocol!=='https:')throw Error('A download needs an HTTPS URL.');
 // Keep HTTPS redirects on HTTPS, and credentials out of command arguments.
 const args=['--config','-','--fail','--silent','--show-error','--location','--proto','=https',
  '--proto-redir','=https','--connect-timeout','20','--speed-limit','1024','--speed-time','60',
  '--output',output,'--write-out','%{http_code}',url];
 for(const [name,value] of Object.entries(headers)){
  if(/[\r\n]/.test(name+value))throw Error('Invalid download header.');
  config+='header = '+JSON.stringify(name+': '+value)+'\n';
 }
 return {args,options:{input:config,env:environment,encoding:'utf8',maxBuffer:Infinity}};
}
/** Six transient-only attempts, including response bodies, with stall detection.
 * Identity checks belong to callers, outside this transport retry boundary. */
export async function downloadFile(url,output,{run=execFile,wait=sleep,...options}={}){
 return retryNetworkAsync(async()=>{
  const {args,options:runOptions}=request(url,output,options);
  try{
   await new Promise((resolve,reject)=>{
    const child=run('curl',args,runOptions,(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve());
    child.stdin.on('error',()=>{});child.stdin.end(runOptions.input);
   });
   return output;
  }catch(error){fs.rmSync(output,{force:true});throw error;}
 },{wait});
}
export function downloadFileSync(url,output,{run=execFileSync,wait=pause,...options}={}){
 return retryNetwork(()=>{
  const {args,options:runOptions}=request(url,output,options);
  try{run('curl',args,runOptions);return output;}
  catch(error){fs.rmSync(output,{force:true});throw error;}
 },{wait});
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
