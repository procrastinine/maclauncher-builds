import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readProjects,resolveProject} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..'),execute=promisify(execFile);

async function request(url,{json=true}={}){
 const parsed=new URL(url),headers={'User-Agent':'MacLauncher-Builds','Accept':json?'application/json':'application/atom+xml'};
 if(parsed.hostname==='api.github.com'&&(process.env.GH_TOKEN||process.env.GITHUB_TOKEN))headers.Authorization='Bearer '+(process.env.GH_TOKEN||process.env.GITHUB_TOKEN);
 const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('Upstream HTTP '+response.status);
 let size=0;const chunks=[];
 for await(const chunk of response.body){size+=chunk.length;if(size>2*1024**2)throw Error('Upstream metadata exceeds its size limit.');chunks.push(chunk);}
 let text=Buffer.concat(chunks).toString('utf8');if(text.startsWith(")]}'"))text=text.slice(text.indexOf('\n')+1);
 return json?JSON.parse(text):text;
}
async function gitHead(url){
 const {stdout}=await execute('git',['ls-remote','--symref',url,'HEAD'],{encoding:'utf8',maxBuffer:1024*1024,timeout:30000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 const revision=/^([a-f0-9]{40})\s+HEAD$/m.exec(stdout)?.[1],branch=/^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(stdout)?.[1];
 if(!revision)throw Error('Upstream HEAD is unavailable.');return {revision,branch};
}
export async function checkProjects(projects,{request:read=request,gitHead:readHead=gitHead}={}){
 const cache=new Map(),memo=(key,action)=>{if(!cache.has(key))cache.set(key,Promise.resolve().then(action));return cache.get(key);};
 const reports=[];
 for(const project of projects){
  const upstreams=[];
  for(const upstream of project.upstreams){
   try{
    let head,release=null,stableRelease=null,releaseStatus='not-applicable',commits=[];
    if(upstream.provider==='github'){
     const base='https://api.github.com/repos/'+upstream.repository;
     try{commits=await memo(base+'/commits',()=>read(base+'/commits?per_page=5'));head={revision:commits[0]?.sha,date:commits[0]?.commit?.committer?.date,title:commits[0]?.commit?.message?.split('\n')[0]};if(!/^[a-f0-9]{40}$/.test(head.revision||''))throw Error('Invalid upstream commit response.');}
     catch{head=await memo(upstream.url+'/HEAD',()=>readHead(upstream.url));}
     try{const releases=await memo(base+'/releases',()=>read(base+'/releases?per_page=10'));const describe=value=>value?{tag:value.tag_name,url:value.html_url,date:value.published_at,prerelease:Boolean(value.prerelease),notes:String(value.body||'').slice(0,6000)}:null;release=describe(releases.find(value=>!value.draft));stableRelease=describe(releases.find(value=>!value.draft&&!value.prerelease));releaseStatus='checked-recent-releases';}
     catch{
      try{const atom=await memo(upstream.url+'/releases.atom',()=>read(upstream.url+'/releases.atom',{json:false}));const entry=/<entry>([\s\S]*?)<\/entry>/.exec(atom)?.[1],url=entry&&/<link[^>]+href="([^"]+\/releases\/tag\/([^"]+))"/.exec(entry);release=url?{tag:decodeURIComponent(url[2]),url:url[1],date:/<updated>([^<]+)<\/updated>/.exec(entry)?.[1]}:null;releaseStatus='atom-feed-unfiltered';}
      catch{releaseStatus='unavailable';}
     }
    }else if(upstream.provider==='gitiles'){
     const log=await memo(upstream.url+'/log',()=>read(upstream.url+'/+log/HEAD?format=JSON&n=5'));
     commits=log.log||[];const first=commits[0];if(!/^[a-f0-9]{40}$/.test(first?.commit||''))throw Error('Invalid upstream Gitiles log.');
     head={revision:first.commit,date:first.committer?.time,title:first.message?.split('\n')[0]};
    }else head=await memo(upstream.url+'/HEAD',()=>readHead(upstream.url));
    upstreams.push({id:upstream.id,url:upstream.url,selectedRevision:upstream.revision,...(upstream.version?{selectedVersion:upstream.version}:{}),head,headChanged:head.revision!==upstream.revision,release,stableRelease,releaseStatus,
     compareUrl:upstream.provider==='github'?upstream.url+'/compare/'+upstream.revision+'...'+head.revision:upstream.provider==='gitiles'?upstream.url+'/+log/'+upstream.revision+'..'+head.revision:upstream.url+'/-/compare/'+upstream.revision+'...'+head.revision,
     recentChanges:commits.slice(0,5).map(value=>({revision:value.sha||value.commit,title:(value.commit?.message||value.message||'').split('\n')[0]}))});
   }catch(error){upstreams.push({id:upstream.id,url:upstream.url,status:'error',error:error.message});}
  }
  reports.push({projectId:project.id,name:project.name,producer:project.producer.kind,...(project.compatibility?{compatibility:project.compatibility}:{}),status:upstreams.some(value=>value.status==='error'||value.releaseStatus==='unavailable')?'incomplete':upstreams.length?'checked':project.producer.kind==='prebuilt'?'pinned-prebuilt':'owned-source',upstreams});
 }
 return {schemaVersion:1,checkedAt:new Date().toISOString(),updatePolicy:'manual',projects:reports};
}
export async function main(args){
 const options={};for(let i=0;i<args.length;i++){
  const key=args[i]?.slice(2);if(args[i]==='--all'){if(options.all)throw Error('Duplicate --all.');options.all=true;continue;}
  if(!args[i]?.startsWith('--')||!['project','output'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project <id> or --all, with optional --output <file>.');options[key]=args[++i];
 }
 if(Boolean(options.all)===Boolean(options.project))throw Error('Select one project or --all.');
 const registry=readProjects(root),projects=options.all?registry.projects:[resolveProject(options.project,root)];
 const report=await checkProjects(projects);
 if(options.output){const output=path.resolve(options.output);if(output===path.join(root,'projects.json')||output.startsWith(path.join(root,'catalogs')+path.sep)||output.startsWith(path.join(root,'recipes')+path.sep))throw Error('Update reports cannot replace project pins or release catalogs.');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
 if(report.projects.some(value=>value.status==='incomplete'))process.exitCode=1;return report;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
