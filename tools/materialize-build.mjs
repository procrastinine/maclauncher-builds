import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {recipeBuildReport} from './recipe-build-report.mjs';
import {appSourceRoot,APP_REFERENCE} from './app-source.mjs';

const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity}).trim();

/** Materialize one project's build definition into a new tree, so its recipe runs with exactly
 * what the definition provides: a sparse checkout of the current commit holding the declared
 * files and the project registry, plus checkouts of the recorded commits of the declared
 * Gitlinks, and of the pinned app source when the definition names app files, each in its own
 * repository (materializeCheckout). A Gitlink that is not initialized stays a commit in the
 * tree's index. */
export function materializeBuild({project,directory,tree}){
 if(!path.isAbsolute(tree||'')||fs.existsSync(tree))throw Error('Choose a new absolute build tree.');
 const root=fs.realpathSync(directory),{definition}=recipeBuildReport({id:project,directory:root});
 const registry=JSON.parse(fs.readFileSync(path.join(root,'projects.json'),'utf8'));
 const files=[...new Set(['projects.json',...(definition.gitlinks.length?['.gitmodules']:[]),...Object.values(registry.registries||{}),...definition.files.map(row=>row.path).filter(file=>!file.startsWith(APP_REFERENCE))])].sort(),declared=new Set(files);
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

 const copied=[];
 for(const link of links){
  if(links.some(parent=>parent!==link&&link.startsWith(parent+'/')))continue;// placed with its parent
  const source=path.join(root,link);
  if(!fs.existsSync(path.join(source,'.git')))continue;
  materializeCheckout({source,destination:path.join(tree,link),revision:git(root,['rev-parse','HEAD:'+link])});copied.push(link);
 }
 return {tree,files:files.length,gitlinks:copied};
}

/** Check out `revision` at `destination` in a repository of its own. Its objects are read from
 * the repository of the initialized checkout `source` through alternates, which nothing here
 * writes; its shallow list, refs and configuration are its own copies, so Git commands run in
 * the checkout (a depth fetch included) never change the source repository. Each initialized
 * checkout below `source` that `revision` records as a Gitlink is placed the same way, unless
 * `recursive` is false. */
export function materializeCheckout({source,destination,revision,recursive=true}){
 const common=git(source,['rev-parse','--path-format=absolute','--git-common-dir']);
 fs.rmSync(destination,{recursive:true,force:true});fs.mkdirSync(destination,{recursive:true});
 git(destination,['init','--quiet']);
 fs.writeFileSync(path.join(destination,'.git/objects/info/alternates'),path.join(common,'objects')+'\n');
 if(fs.existsSync(path.join(common,'shallow')))fs.copyFileSync(path.join(common,'shallow'),path.join(destination,'.git/shallow'));
 // The origin and the initialized submodules keep their configured URLs.
 const settings=(()=>{try{return git(source,['config','--null','--get-regexp','^(remote\\.origin\\.url|submodule\\..*)$']).split('\0').filter(Boolean);}catch{return [];}})();
 for(const entry of settings){const split=entry.indexOf('\n');git(destination,['config','--add',entry.slice(0,split),entry.slice(split+1)]);}
 try{git(destination,['checkout','--quiet','--detach',revision]);}
 catch{throw Error(`Initialize ${source} with commit ${revision} before a materialized build.`);}
 if(!recursive)return destination;
 for(const line of git(destination,['ls-tree','-r','--full-tree',revision]).split('\n')){
  const [,commit,place]=/^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line)||[];
  if(commit&&fs.existsSync(path.join(source,place,'.git')))materializeCheckout({source:path.join(source,place),destination:path.join(destination,place),revision:commit});
 }
 return destination;
}
