import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {downloadFile,downloadFileSync,transientDownload,retryNetwork} from '../tools/download.mjs';
import {buildInput} from '../tools/build-input.mjs';
test('download and portable producer modules remain synchronously require-able',()=>{
 const require=createRequire(import.meta.url);
 assert.equal(typeof require('../tools/download.mjs').downloadFile,'function');
 assert.equal(typeof require('../tools/build-portable-runtime.mjs').buildPortableRuntime,'function');
});
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'download-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function runner(reply){return (_command,args,options,callback)=>{
 const result=reply(args,options);if(callback){callback(result?.error,result?.stdout||'200',result?.stderr||'');return {stdin:{on(){},end(){}}};}
 if(result?.error)throw Object.assign(result.error,{stdout:result.stdout});return result?.stdout||'200';
};}
test('only transient transport errors, rate limits and server failures qualify for retry',()=>{
 for(const code of [6,7,18,28,52,55,56,92])assert.equal(transientDownload({code}),true);
 for(const status of [408,429,500,502,503,504,599])assert.equal(transientDownload({code:22,stdout:String(status)}),true);
 for(const status of [400,401,403,404,410])assert.equal(transientDownload({code:22,stdout:String(status)}),false);
 assert.equal(transientDownload({code:60}),false);assert.equal(transientDownload(Error('checksum mismatch')),false);
});
test('both paths enforce HTTPS and stall detection without capping healthy transfers',async t=>{
 const directory=temporary(t);let calls=0;
 const run=runner((args,options)=>{calls++;assert.equal(args.includes('--max-time'),false);
  for(const [flag,value]of [['--proto','=https'],['--proto-redir','=https'],['--connect-timeout','20'],['--speed-limit','1024'],['--speed-time','60']])assert.equal(args[args.indexOf(flag)+1],value);
  assert.ok(options.input.includes('X-Build-Input: exact'));fs.writeFileSync(args[args.indexOf('--output')+1],'healthy large transfer');});
 for(const download of [downloadFile,downloadFileSync]){
  const output=path.join(directory,'input');await download('https://example.invalid/large-input',output,{run,headers:{'X-Build-Input':'exact'}});assert.equal(fs.readFileSync(output,'utf8'),'healthy large transfer');
 }
 assert.equal(calls,2);
 for(const url of ['http://example.invalid/input','file:///tmp/input']){
  await assert.rejects(downloadFile(url,path.join(directory,'invalid'),{run}),/HTTPS/);
  assert.throws(()=>downloadFileSync(url,path.join(directory,'invalid'),{run}),/HTTPS/);
 }
 assert.equal(calls,2);
});
test('async retries discard partial bodies and back off only after transient failures',async t=>{
 const directory=temporary(t),output=path.join(directory,'input'),delays=[];let calls=0;
 const run=runner(args=>{calls++;fs.writeFileSync(output,calls===3?'original pinned bytes':'partial body');return calls<3?{error:Object.assign(Error('HTTP failure'),{code:22}),stdout:calls===1?'429':'503'}:{};});
 await downloadFile('https://example.invalid/input',output,{run,wait:async delay=>{delays.push(delay);assert.equal(fs.existsSync(output),false);}});
 assert.equal(calls,3);assert.deepEqual(delays,[1000,2000]);assert.equal(fs.readFileSync(output,'utf8'),'original pinned bytes');
 calls=0;await assert.rejects(downloadFile('https://example.invalid/missing',output,{run:runner(()=>{calls++;return {error:Object.assign(Error('HTTP 404'),{code:22}),stdout:'404'};}),wait:()=>assert.fail('No delay after a permanent failure')}),/404/);assert.equal(calls,1);assert.equal(fs.existsSync(output),false);
});
test('synchronous retries are bounded and handle truncated transfers',t=>{
 const output=path.join(temporary(t),'input'),delays=[];let calls=0;
 const run=runner(args=>{calls++;fs.writeFileSync(output,calls===2?'complete input':'partial');return calls===1?{error:Object.assign(Error('truncated'),{code:18})}:{};});
 downloadFileSync('https://example.invalid/input',output,{run,wait:delay=>delays.push(delay)});assert.equal(calls,2);assert.deepEqual(delays,[1000]);assert.equal(fs.readFileSync(output,'utf8'),'complete input');
 calls=0;delays.length=0;assert.throws(()=>downloadFileSync('https://example.invalid/stalled',output,{run:runner(()=>{calls++;return {error:Object.assign(Error('stalled'),{code:28})};}),wait:delay=>delays.push(delay)}),/stalled/);assert.equal(calls,5);assert.deepEqual(delays,[1000,2000,4000,8000]);assert.equal(fs.existsSync(output),false);
});
test('network steps repeat with backoff and report the last failure',()=>{
 const delays=[];let calls=0;
 assert.equal(retryNetwork(()=>{calls++;if(calls<3)throw Error('early EOF '+calls);return 'fetched';},{wait:delay=>delays.push(delay)}),'fetched');
 assert.equal(calls,3);assert.deepEqual(delays,[1000,2000]);
 calls=0;delays.length=0;
 assert.throws(()=>retryNetwork(()=>{calls++;throw Error('RPC failed '+calls);},{wait:delay=>delays.push(delay)}),/^Error: RPC failed 5$/);
 assert.equal(calls,5);assert.deepEqual(delays,[1000,2000,4000,8000]);
});
test('a downloaded checksum mismatch is not retried and never becomes a cached input',async t=>{
 const directory=temporary(t),count=path.join(directory,'calls'),cache=path.join(directory,'cache');
 fs.writeFileSync(path.join(directory,'curl'),`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(count)},'attempt\\n');fs.writeFileSync(args[args.indexOf('--output')+1],'wrong bytes');process.stdout.write('200');\n`,{mode:0o755});
 const previousPath=process.env.PATH;t.after(()=>{process.env.PATH=previousPath;});
 process.env.PATH=directory+path.delimiter+previousPath;
 await assert.rejects(buildInput({url:'https://example.invalid/pinned',sha256:'a'.repeat(64),bytes:11},cache),/checksum or size differs/);
 assert.equal(fs.readFileSync(count,'utf8'),'attempt\n');assert.deepEqual(fs.readdirSync(cache),[]);
});
