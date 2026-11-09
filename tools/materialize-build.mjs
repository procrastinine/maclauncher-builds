import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {recipeBuildReport} from './recipe-build-report.mjs';
import {appSourceRoot,APP_REFERENCE} from './app-source.mjs';

const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity}).trim();
const copy=(source,destination)=>{fs.mkdirSync(path.dirname(destination),{recursive:true});fs.cpSync(source,destination,{recursive:true,verbatimSymlinks:true,mode:fs.constants.COPYFILE_FICLONE});};

/** Materialize one project's build definition into a new tree, so its recipe runs with exactly
 * what the definition provides: a sparse checkout of the current commit holding the declared
 * files and the project registry, plus copies of the initialized checkouts of the declared
 * Gitlinks, and of the pinned app source when the definition names app files, each with its
 * own Git data. A Gitlink that is not initialized stays a commit in the tree's index. */
export function materializeBuild({project,directory,tree}){
 if(!path.isAbsolute(tree||'')||fs.existsSync(tree))throw Error('Choose a new absolute build tree.');
 const root=fs.realpathSync(directory),{definition}=recipeBuildReport({id:project,directory:root});
 const registry=JSON.parse(fs.readFileSync(path.join(root,'projects.json'),'utf8'));
 const files=[...new Set(['projects.json',...Object.values(registry.registries||{}),...definition.files.map(row=>row.path).filter(file=>!file.startsWith(APP_REFERENCE))])].sort(),declared=new Set(files);
 const changed=execFileSync('git',['status','--porcelain=v1','-z','--untracked-files=no','--ignore-submodules=all'],{cwd:root,encoding:'utf8',maxBuffer:Infinity}).split('\0').filter(Boolean).map(entry=>entry.slice(3));
 if(changed.some(file=>declared.has(file)))throw Error('Commit the declared build files before a materialized build.');
 const app=definition.files.some(row=>row.path.startsWith(APP_REFERENCE))?[path.relative(root,appSourceRoot(root).directory)]:[];
 const links=[...new Set([...definition.gitlinks.map(row=>row.path),...app])].sort();

 fs.mkdirSync(tree,{recursive:true});git(tree,['init','--quiet']);
 const gitPath=name=>git(root,['rev-parse','--path-format=absolute','--git-path',name]);
 fs.writeFileSync(path.join(tree,'.git/objects/info/alternates'),gitPath('objects')+'\n');
 if(fs.existsSync(gitPath('shallow')))fs.copyFileSync(gitPath('shallow'),path.join(tree,'.git/shallow'));
 git(tree,['config','core.sparseCheckout','true']);
 fs.writeFileSync(path.join(tree,'.git/info/sparse-checkout'),files.map(file=>'/'+file.replace(/([*?[\\!#])/g,'\\$1')).join('\n')+'\n');
 git(tree,['checkout','--quiet','--detach',git(root,['rev-parse','HEAD'])]);

 // A copied checkout's .git file names its Git directory relative to the original; each Git
 // directory is copied once into the tree and every .git file below the copy points at its copy.
 const copies=new Map(),copied=[];
 const absorb=(destination,source)=>{
  const pointers=execFileSync('find',[destination,'-name','.git','-type','f'],{encoding:'utf8',maxBuffer:Infinity}).split('\n').filter(Boolean).sort((a,b)=>a.length-b.length);
  for(const file of pointers){
   const checkout=path.dirname(file),from=path.resolve(path.join(source,path.relative(destination,checkout)),/^gitdir: (.+)$/m.exec(fs.readFileSync(file,'utf8'))[1].trim());
   const parent=[...copies.keys()].find(key=>from===key||from.startsWith(key+path.sep));
   const target=parent?copies.get(parent)+from.slice(parent.length):path.join(tree,'.git/materialized',String(copies.size));
   if(!parent){copy(from,target);copies.set(from,target);}
   const common=path.join(target,'commondir');if(fs.existsSync(common))fs.writeFileSync(common,path.resolve(from,fs.readFileSync(common,'utf8').trim())+'\n');
   git(tree,['config','-f',path.join(target,'config'),'core.worktree',checkout]);fs.writeFileSync(file,'gitdir: '+target+'\n');
  }
 };
 for(const link of links){
  if(links.some(parent=>parent!==link&&link.startsWith(parent+'/')))continue;// copied with its parent
  const source=path.join(root,link),destination=path.join(tree,link);
  if(!fs.existsSync(path.join(source,'.git')))continue;
  fs.rmSync(destination,{recursive:true,force:true});copy(source,destination);absorb(destination,source);copied.push(link);
 }
 return {tree,files:files.length,gitlinks:copied};
}
