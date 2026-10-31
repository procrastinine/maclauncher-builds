import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {checkoutSource} from './build-source.mjs';
const read=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

/** The original producer's consumed source options select its exact Git inputs. */
export async function androidCommonSourceRecords(android){
 android=fs.realpathSync(android);
 const {sourceOptions}=await import(pathToFileURL(path.join(android,'src/modules/android/native/build-options.mjs')));
 const modules=new Map();
 for(const section of fs.readFileSync(path.join(android,'.gitmodules'),'utf8').split(/^\[submodule /m).slice(1)){
  const fields=Object.fromEntries([...section.matchAll(/^\s*(path|url|maclauncher-revision)\s*=\s*(\S+)\s*$/gm)].map(row=>[row[1],row[2]]));
  if(fields.path)modules.set(fields.path,fields);
 }
 const options={...sourceOptions(path.join(android,'src/modules/android/native')),klepton:'klepton',converter:'dex2jvm','gles-headers':'android-gles-headers'},records=[];
 for(const [option,supplier]of Object.entries(options)){
  const input='src/external/'+supplier,fields=modules.get(input);
  if(!fields||!/^https:\/\//.test(fields.url)||!/^[a-f0-9]{40}$/.test(fields['maclauncher-revision']||''))throw Error('The Android source option has no exact public Git declaration: '+option);
  const revision=fields['maclauncher-revision'];
  if(read(android,['ls-tree','HEAD','--',input])!==`160000 commit ${revision}\t${input}`)throw Error('The Android source option differs from its Gitlink: '+option);
  records.push({option,path:input,repository:fields.url,revision});
 }
 return records;
}

/** Acquire immutable upstream checkouts outside the selected Android source. */
export async function checkoutAndroidCommonSources({android,work}){
 if(!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Android source acquisition requires a new absolute work directory.');
 fs.mkdirSync(work,{recursive:true});const options={},sources=new Map();
 for(const record of await androidCommonSourceRecords(android)){
  const key=record.repository+'@'+record.revision;
  if(!sources.has(key))sources.set(key,checkoutSource({repository:record.repository,revision:record.revision,destination:path.join(work,String(sources.size)+'-'+path.basename(record.path))}));
  options[record.option]=sources.get(key);
 }
 return options;
}
