import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Initialize only declared Gitlink paths, including nested production sources. */
export function initializeSources({project:id,version,directory=root,run=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32<<20})}){
 const project=resolveProject(id,directory,{resolvePins:false}),build=buildRecord(project,version),initialized=[],done=new Set();
 for(const selected of build.submodules||[]){
  let current=directory,remaining=selected;
  while(remaining){
   const links=String(run(['ls-files','--stage'],current)).split('\n').flatMap(line=>{const match=line.match(/^160000 [a-f0-9]{40} 0\t(.+)$/);return match?[match[1]]:[];});
   const link=links.find(name=>remaining===name||remaining.startsWith(name+'/'));
   if(!link)throw Error('Declared source is not a registered Gitlink: '+selected);
   const recursive=build.recursiveSubmodules===true&&remaining===link,key=path.join(current,link)+'/'+recursive;
   if(!done.has(key)){run(['submodule','update','--init','--depth','1',...(recursive?['--recursive']:[]),'--',link],current);done.add(key);initialized.push({path:path.relative(directory,path.join(current,link)).split(path.sep).join('/'),recursive});}
   current=path.join(current,link);remaining=remaining===link?'':remaining.slice(link.length+1);
  }
 }
 return {project:id,version:build.version,initialized};
}
export function main(args){const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','version'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project and --version.');options[key]=args[i+1];}return initializeSources(options);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
