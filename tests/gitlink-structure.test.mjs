import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitlinkRevisions} from '../lib/pins.mjs';

const root=path.resolve(import.meta.dirname,'..');
const git=(directory,...args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
/** A repository URL in one comparable form: no scheme, user, trailing slash or .git suffix. */
const comparable=url=>url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i,'').replace(/^[^@/]+@/,'').replace(/^([^/:]+):(?!\d)/,'$1/').replace(/\/+$/,'').replace(/\.git$/,'').toLowerCase();
/** The URL each submodule path of a commit's .gitmodules names. */
function submoduleUrls(directory,commit){
 let listing='';
 try{listing=git(directory,'config','--blob',commit+':.gitmodules','--get-regexp','^submodule\\..*\\.(path|url)$');}catch{return new Map();}
 const entries=new Map();
 for(const line of listing.split('\n').filter(Boolean)){
  const space=line.indexOf(' '),key=line.slice(0,space),dot=key.lastIndexOf('.'),name=key.slice('submodule.'.length,dot);
  entries.set(name,{...entries.get(name),[key.slice(dot+1)]:line.slice(space+1)});
 }
 return new Map([...entries.values()].filter(entry=>entry.path&&entry.url).map(entry=>[entry.path,comparable(entry.url)]));
}
/** Every upstream this repository pins at one commit from more than one gitlink, and every pinned
 * repository whose checkout pins this repository back. A pinned repository is read only when its
 * checkout is initialized. */
export function gitlinkFindings(directory=root){
 const name=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8')).name,urls=submoduleUrls(directory,'HEAD'),places=new Map(),findings=[];
 for(const [gitlink,commit] of gitlinkRevisions(directory)){
  const url=urls.get(gitlink);
  if(!url){findings.push(`${gitlink} has no .gitmodules URL`);continue;}
  places.set(url+'@'+commit,[...(places.get(url+'@'+commit)||[]),gitlink]);
  const checkout=path.join(directory,gitlink);
  if(!fs.existsSync(path.join(checkout,'.git')))continue;
  for(const [inner,innerUrl] of submoduleUrls(checkout,commit))
   if(innerUrl.split('/').pop()===name)findings.push(`${gitlink} pins ${name} back at ${inner}`);
 }
 for(const [key,gitlinks] of places)if(gitlinks.length>1)findings.push(`${key} is pinned at ${gitlinks.join(' and ')}`);
 return findings;
}

function repository(t,name,files={},gitlinks={}){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gitlinks-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const run=(...args)=>execFileSync('git',['-C',directory,...args],{stdio:'ignore'});
 run('init','-q');run('config','user.name','fixture');run('config','user.email','fixture@example.invalid');
 for(const [file,text] of Object.entries({'package.json':JSON.stringify({name}),...files})){fs.mkdirSync(path.dirname(path.join(directory,file)),{recursive:true});fs.writeFileSync(path.join(directory,file),text);}
 run('add','-A');
 for(const [gitlink,commit] of Object.entries(gitlinks))run('update-index','--add','--cacheinfo','160000,'+commit+','+gitlink);
 run('commit','-q','-m','fixture');
 return directory;
}
const modules=entries=>entries.map(([gitlink,url])=>`[submodule "${gitlink}"]\n\tpath = ${gitlink}\n\turl = ${url}\n`).join('');

test('one upstream commit pinned from two gitlinks is reported, and distinct commits are not',t=>{
 const commit='1'.repeat(40),other='2'.repeat(40);
 const directory=repository(t,'builds',{'.gitmodules':modules([['sources/a','https://example.invalid/owner/lib.git'],['producers/b','git@example.invalid:Owner/lib'],['sources/c','https://example.invalid/owner/lib/']])},
  {'sources/a':commit,'producers/b':commit,'sources/c':other});
 assert.deepEqual(gitlinkFindings(directory),['example.invalid/owner/lib@'+commit+' is pinned at producers/b and sources/a']);
});

test('a pinned repository that pins this repository back is reported',t=>{
 const pinned=repository(t,'pinned',{'.gitmodules':modules([['sources/builds','https://example.invalid/owner/builds.git']])},{'sources/builds':'3'.repeat(40)});
 const commit=git(pinned,'rev-parse','HEAD').trim();
 const directory=repository(t,'builds',{'.gitmodules':modules([['sources/pinned','https://example.invalid/owner/pinned']])},{'sources/pinned':commit});
 assert.deepEqual(gitlinkFindings(directory),[]);
 fs.mkdirSync(path.join(directory,'sources'),{recursive:true});
 execFileSync('git',['clone','-q','--no-checkout',pinned,path.join(directory,'sources/pinned')],{stdio:'ignore'});
 assert.deepEqual(gitlinkFindings(directory),['sources/pinned pins builds back at sources/builds']);
});

test('Builds pins each upstream commit once and pins no repository that pins Builds back',()=>{
 assert.deepEqual(gitlinkFindings(),[]);
});
