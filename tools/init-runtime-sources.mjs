import './producer-environment.mjs';
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {retryNetwork} from './download.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Initialize only declared Gitlink paths, including nested production sources. */
const runGit=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity});
const appSource=directory=>JSON.parse(fs.readFileSync(path.join(directory,'producers/package-support/app-source.json'),'utf8'));
/** Sources every repository tool reads: the pinned app source. */
const toolPaths=directory=>[appSource(directory).gitlink];
/** Sources the planner reads for pin metadata. */
const metadataPaths=directory=>appSource(directory).sourceSubmodules;
const gitlinks=(directory,run)=>String(run(['ls-files','--stage'],directory)).split('\n').flatMap(line=>{const match=line.match(/^160000 [a-f0-9]{40} 0\t(.+)$/);return match?[match[1]]:[];});
/** Sources npm test reads: the planner's sources and every pinned source repository. */
const checkPaths=(directory,run)=>[...metadataPaths(directory),...gitlinks(directory,run).filter(link=>/^sources\/[^/]+$/.test(link))];
function initializeGitlinks({paths,directory,run,allowRecursive=false}){
 const initialized=[],done=new Set();
 for(const selected of paths){
  let current=directory,remaining=selected;
  while(remaining){
   const links=String(run(['ls-files','--stage'],current)).split('\n').flatMap(line=>{const match=line.match(/^160000 [a-f0-9]{40} 0\t(.+)$/);return match?[match[1]]:[];});
   const link=links.find(name=>remaining===name||remaining.startsWith(name+'/'));
   if(!link)throw Error('Declared source is not a registered Gitlink: '+selected);
   const recursive=allowRecursive&&remaining===link&&!toolPaths(directory).includes(link),key=path.join(current,link)+'/'+recursive;
   if(!done.has(key)){
    const args=['submodule','update','--init'];
    retryNetwork(()=>{
     try{run([...args,'--depth','1',...(recursive?['--recursive']:[]),'--',link],current);}
     catch(error){
      if(!/dumb http transport does not support shallow capabilities/i.test(String(error.stderr||error.message)))throw error;
      // The pinned commit is unchanged; older Git servers need a full fetch.
      run([...args,...(recursive?['--recursive']:[]),'--',link],current);
     }
    });
    done.add(key);initialized.push({path:path.relative(directory,path.join(current,link)).split(path.sep).join('/'),recursive});
   }
   current=path.join(current,link);remaining=remaining===link?'':remaining.slice(link.length+1);
  }
 }
 return initialized;
}
export function initializeToolSources({directory=root,run=runGit}={}){return initializeGitlinks({paths:toolPaths(directory),directory,run});}
export function initializeMetadataSources({directory=root,run=runGit}={}){return initializeGitlinks({paths:metadataPaths(directory),directory,run});}
export function initializeCheckSources({directory=root,run=runGit}={}){return initializeGitlinks({paths:checkPaths(directory,run),directory,run});}
export function initializeSources({project:id,version,directory=root,run=runGit}){
 const project=resolveProject(id,directory,{resolvePins:false}),build=buildRecord(project,version);
 return {project:id,version:build.version,initialized:initializeGitlinks({paths:[...metadataPaths(directory),...(build.submodules||[])],directory,run,allowRecursive:build.recursiveSubmodules===true})};
}
/** The one source preparation entry for every job: no arguments for the tool
 * sources, --metadata for planning, --checks for npm test, or one build. */
export function main(args){if(!args.length)return initializeToolSources();if(args.length===1&&args[0]==='--metadata')return initializeMetadataSources();if(args.length===1&&args[0]==='--checks')return initializeCheckSources();const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','version'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project and --version.');options[key]=args[i+1];}return initializeSources(options);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
