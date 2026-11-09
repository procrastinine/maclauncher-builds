// Local stand-in for a hosted job: a fresh checkout of one Builds commit with no
// submodule contents, where the job's own source steps run against a git that
// serves pinned commits from this tree's initialized sources. Each tool the job
// runs is then loaded, and the index is generated, exactly as the job would.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'../..');
const git=(cwd,args,options={})=>execFileSync('git',args,{cwd,maxBuffer:Infinity,...options});
const realGit=execFileSync('sh',['-c','command -v git'],{encoding:'utf8'}).trim();

/** Jobs of every workflow at a commit, with composite actions expanded into their steps. */
export function workflowJobs(commit,directory=root){
 const show=file=>{try{return git(directory,['show',commit+':'+file],{encoding:'utf8'});}catch{return '';}};
 const steps=text=>text.split(/\n {4,6}- /).slice(1);
 const expand=step=>{const local=step.match(/uses: \.\/\.github\/actions\/([\w-]+)/);return local?steps('\n'+(show('.github/actions/'+local[1]+'/action.yml').split(/\n {2}steps:\n/)[1]||'')).flatMap(expand):[step];};
 const files=git(directory,['ls-tree','--name-only',commit,'.github/workflows/'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 return files.flatMap(file=>show(file).split(/\n {2}(?=[A-Za-z][\w-]*:\n)/).slice(1).flatMap(job=>{
  const body=job.split(/\n {4}steps:\n/)[1];return body?[{workflow:path.basename(file),job:job.split(':')[0],steps:steps('\n'+body).flatMap(expand)}]:[];
 }));
}

/** Simulate one job: returns {prepared, loaded, index, error}. */
export function runJob({commit='HEAD',job,directory=root,keep=false}){
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'job-standin-'))),checkout=path.join(work,'checkout'),bin=path.join(work,'bin'),state=path.join(work,'state.json');
 try{
  fs.mkdirSync(checkout);fs.mkdirSync(bin);
  const sha=git(directory,['rev-parse',commit],{encoding:'utf8'}).trim();
  // A fresh checkout: the commit's tree, gitlinks empty. (.gitmodules is not needed by the job tools.)
  execFileSync('sh',['-c','git -C "$1" archive "$2" | tar -x -C "$3" --exclude=.gitmodules','sh',directory,sha,checkout]);
  fs.writeFileSync(state,JSON.stringify({[checkout]:{repo:directory,sha}}));
  fs.writeFileSync(path.join(bin,'git'),'#!/bin/sh\nexec "'+process.execPath+'" "'+path.join(import.meta.dirname,'job-standin.mjs')+'" git "$@"\n',{mode:0o755});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,JOB_STANDIN_STATE:state,JOB_STANDIN_TREE:directory,JOB_STANDIN_GIT:realGit,RUNNER_TEMP:work,MACLAUNCHER_PACKAGE_PRODUCER:'1'};
  const result={prepared:[],loaded:[],index:null,error:null};
  for(const step of job.steps){
   const run=(step.match(/run: (.+)$/m)?.[1]||'').replace(/^\|$/,'')||step.split(/run: \|\n/)[1]||'';
   if(/submodule|init-runtime-sources/.test(run)){try{execFileSync('bash',['-c',run],{cwd:checkout,env,stdio:'pipe'});}catch(error){{const lines=String(error.stderr||error.message).trim().split('\n');result.error='source step: '+(lines.find(line=>/^Error|ERR_|initialized checkout/.test(line))||lines.at(-1));}return result;}}
   for(const [,tool] of run.matchAll(/node (tools\/[\w.-]+\.(?:mjs|cjs))/g)){
    if(tool.endsWith('init-runtime-sources.mjs'))continue;
    try{execFileSync(process.execPath,['--input-type=module','-e','await import('+JSON.stringify(pathToFileURL(path.join(checkout,tool)).href)+')'],{cwd:checkout,env,stdio:'pipe'});result.loaded.push(tool);}
    catch(error){result.error=tool+': '+String(error.stderr||error.message).split('\n').find(line=>/Error/.test(line));return result;}
   }
   if(/npm run index:build/.test(run)){
    try{result.index=JSON.parse(execFileSync(process.execPath,['tools/package-index.mjs','--output',path.join(work,'site')],{cwd:checkout,env,encoding:'utf8'}));}
    catch(error){result.error='index: '+String(error.stderr||error.message).split('\n').find(line=>/Error/.test(line));return result;}
   }
  }
  result.prepared=Object.keys(JSON.parse(fs.readFileSync(state,'utf8'))).filter(dir=>dir!==checkout).map(dir=>path.relative(checkout,dir));
  return result;
 }finally{if(!keep)fs.rmSync(work,{recursive:true,force:true});}
}

/** The git the job's steps see: ls-files and submodule update served from pinned local sources. */
function standinGit(args){
 const state=JSON.parse(fs.readFileSync(process.env.JOB_STANDIN_STATE,'utf8')),cwd=fs.realpathSync(process.cwd()),here=state[cwd];
 const links=({repo,sha})=>execFileSync(process.env.JOB_STANDIN_GIT,['-C',repo,'ls-tree','-r',sha],{encoding:'utf8',maxBuffer:Infinity}).split('\n').flatMap(line=>{const match=line.match(/^160000 commit ([a-f0-9]{40})\t(.+)$/);return match?[{sha:match[1],path:match[2]}]:[];});
 if(args[0]==='ls-files'&&here){process.stdout.write(links(here).map(link=>'160000 '+link.sha+' 0\t'+link.path+'\n').join(''));return;}
 if(args[0]==='submodule'&&args[1]==='update'&&here){
  for(const name of args.slice(args.indexOf('--')+1)){
   const link=links(here).find(row=>row.path===name);if(!link)throw Error('not a gitlink: '+name);
   // The pinned commit comes from this tree's initialized checkout of the same path.
   const relative=path.relative(Object.keys(state)[0],path.join(cwd,name)),local=path.join(process.env.JOB_STANDIN_TREE,relative),target=path.join(cwd,name);
   try{execFileSync(process.env.JOB_STANDIN_GIT,['-C',local,'cat-file','-e',link.sha+'^{commit}'],{stdio:'ignore'});}catch{throw Error('this tree has no initialized checkout of '+relative+' to serve '+link.sha);}
   execFileSync('sh',['-c','"$1" -C "$2" archive "$3" | tar -x -C "$4"','sh',process.env.JOB_STANDIN_GIT,local,link.sha,target]);
   state[fs.realpathSync(target)]={repo:local,sha:link.sha};
  }
  fs.writeFileSync(process.env.JOB_STANDIN_STATE,JSON.stringify(state));return;
 }
 execFileSync(process.env.JOB_STANDIN_GIT,args,{stdio:'inherit'});
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const [command,...args]=process.argv.slice(2);
 if(command==='git'){try{standinGit(args);}catch(error){console.error(error.message);process.exit(1);}}
 else{
  // node tests/helpers/job-standin.mjs <commit> [workflow/job ...]
  const commit=command||'HEAD',selected=args.length?args:null;
  for(const job of workflowJobs(commit).filter(job=>!selected||selected.includes(job.workflow+'/'+job.job))){
   const result=runJob({commit,job});console.log(job.workflow+'/'+job.job+': '+(result.error?'FAIL '+result.error:'ok, prepared ['+result.prepared.join(', ')+'], loaded '+result.loaded.length+' tools'+(result.index?', index '+result.index.packages+' packages':'')));
  }
 }
}
