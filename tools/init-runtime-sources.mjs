import './producer-environment.mjs';
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {retryNetwork} from './download.mjs';
import {appNestedFiles,checkoutGitlinkFiles} from './app-source.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
// This tool runs before any source exists; the project registry it reads names no file inside a source.
/** Initialize only declared Gitlink paths, including nested production sources. */
const runGit=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity});
const appSource=directory=>JSON.parse(fs.readFileSync(path.join(directory,'producers/package-support/app-source.json'),'utf8'));
/** Sources the publication and index tools read: the pinned app source. */
const toolPaths=directory=>[appSource(directory).gitlink];
const APP_SOURCE='producers/package-support/app-source.json';
/** Only a project that declares app-source.json reads the app. */
const readsApp=project=>(project.producer?.entries||[]).includes(APP_SOURCE);
/** A declared app file that is a symlink into one of the app's own gitlinks is that gitlink's
 * file at the commit the app records, so the gitlink is a source of the project declaring it. */
const nestedAppPaths=(projects,directory)=>{const entries=projects.flatMap(project=>project.producer?.appEntries||[]);return entries.length?[...new Set(appNestedFiles(entries,directory).map(row=>row.gitlink))]:[];};
// One entry's state: the gitlinks it initialized (path and recursion) and each superproject's
// gitlinks, listed once.
const sourceState=()=>({done:new Set(),listed:new Map()});
const gitlinks=(directory,run,state=sourceState())=>{
 if(!state.listed.has(directory))state.listed.set(directory,String(run(['ls-files','--stage'],directory)).split('\n').flatMap(line=>{const match=line.match(/^160000 [a-f0-9]{40} 0\t(.+)$/);return match?[match[1]]:[];}));
 return state.listed.get(directory);
};
const registry=directory=>require('../lib/projects.mjs').readProjects(directory,{resolvePins:false}).projects;
// Parallel clones within one submodule update.
const CLONE_JOBS='8';
/** Initialize the declared gitlink paths, level by level: one `submodule update` per superproject
 * and recursion group, then the gitlinks inside them. The result lists each newly initialized
 * gitlink once, in the order of the paths that name it. */
export function initializeGitlinks({paths,directory,run,allowRecursive=false,state=sourceState()}){
 const items=paths.map(selected=>({selected,current:directory,remaining:selected,chain:[]})),fresh=new Set();
 for(let level=items;level.length;){
  const groups=new Map(),next=[];
  for(const item of level){
   const link=gitlinks(item.current,run,state).find(name=>item.remaining===name||item.remaining.startsWith(name+'/'));
   if(!link)throw Error('Declared source is not a registered Gitlink: '+item.selected);
   const recursive=allowRecursive&&item.remaining===link&&!toolPaths(directory).includes(link),key=path.join(item.current,link)+'/'+recursive;
   item.chain.push({key,path:path.relative(directory,path.join(item.current,link)).split(path.sep).join('/'),recursive});
   if(!state.done.has(key)&&!fresh.has(key)){
    fresh.add(key);const group=item.current+'\0'+recursive;
    if(!groups.has(group))groups.set(group,{current:item.current,recursive,links:[]});
    groups.get(group).links.push(link);
   }
   if(item.remaining!==link)next.push(Object.assign(item,{current:path.join(item.current,link),remaining:item.remaining.slice(link.length+1)}));
  }
  for(const {current,recursive,links} of groups.values()){
   const args=['submodule','update','--init','--jobs',CLONE_JOBS];
   retryNetwork(()=>{
    try{run([...args,'--depth','1',...(recursive?['--recursive']:[]),'--',...links],current);}
    catch(error){
     if(!/dumb http transport does not support shallow capabilities/i.test(String(error.stderr||error.message)))throw error;
     // The pinned commits are unchanged; older Git servers need a full fetch.
     run([...args,...(recursive?['--recursive']:[]),'--',...links],current);
    }
   });
  }
  level=next;
 }
 const initialized=[];
 for(const row of items.flatMap(item=>item.chain))if(fresh.delete(row.key)){state.done.add(row.key);initialized.push({path:row.path,recursive:row.recursive});}
 return initialized;
}
export function initializeToolSources({directory=root,run=runGit}={}){return initializeGitlinks({paths:toolPaths(directory),directory,run});}
/** Sources the planner reads to describe every package: each gitlink holding a file a project
 * names by path (an entry or a source record file), and the app with its declared nested gitlinks
 * when any project reads the app. */
export function initializeMetadataSources({directory=root,run=runGit,state=sourceState()}={}){
 const projects=registry(directory),links=gitlinks(directory,run,state),appProjects=projects.filter(readsApp);
 const named=projects.flatMap(project=>[...(project.producer?.entries||[]),...(project.upstreams||[]).flatMap(upstream=>typeof upstream.pin?.file==='string'?[upstream.pin.file]:[])]);
 const holding=links.filter(link=>named.some(name=>name.startsWith(link+'/')));
 const initialized=initializeGitlinks({paths:[...(appProjects.length?toolPaths(directory):[]),...holding],directory,run,state});
 return [...initialized,...initializeGitlinks({paths:nestedAppPaths(appProjects,directory),directory,run,state})];
}
/** Sources npm test reads: the planner's sources, every pinned source repository and the
 * gitlinks each of those repositories' own symlinks point into. */
export function initializeCheckSources({directory=root,run=runGit}={}){
 const state=sourceState(),repositories=gitlinks(directory,run,state).filter(link=>/^sources\/[^/]+$/.test(link));
 const initialized=[...initializeMetadataSources({directory,run,state}),...initializeGitlinks({paths:repositories,directory,run,state})];
 const linked=repositories.flatMap(repository=>fs.existsSync(path.join(directory,repository,'.git'))?checkoutGitlinkFiles(path.join(directory,repository)).map(row=>repository+'/'+row.gitlink):[]);
 return [...initialized,...initializeGitlinks({paths:[...new Set(linked)],directory,run,state})];
}
/** One build initializes only its declared sources: its build submodules and, when it declares
 * app-source.json, the app and the app gitlinks its declared app files lie in. */
export function initializeSources({project:id,version,directory=root,run=runGit}){
 const {resolveProject,buildRecord}=require('../lib/projects.mjs'),project=resolveProject(id,directory,{resolvePins:false}),build=buildRecord(project,version);
 // Recursion applies only to the build's own sources; the app and its gitlinks are never recursive.
 const state=sourceState(),app=readsApp(project)?[...initializeGitlinks({paths:toolPaths(directory),directory,run,state})]:[];
 if(readsApp(project))app.push(...initializeGitlinks({paths:nestedAppPaths([project],directory),directory,run,state}));
 return {project:id,version:build.version,initialized:[...app,...initializeGitlinks({paths:build.submodules||[],directory,run,allowRecursive:build.recursiveSubmodules===true,state})]};
}
/** The one source preparation entry for every job: no arguments for the
 * publication and index tools, --metadata for planning, --checks for npm test,
 * or --project (and --version) for one build. */
export function main(args){if(!args.length)return initializeToolSources();if(args.length===1&&args[0]==='--metadata')return initializeMetadataSources();if(args.length===1&&args[0]==='--checks')return initializeCheckSources();const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','version'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project and --version.');options[key]=args[i+1];}return initializeSources(options);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
