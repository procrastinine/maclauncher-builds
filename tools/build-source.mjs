import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {retryNetwork} from './download.mjs';
import {sourceCheckout,sourceRevision} from '../lib/pins.mjs';
import {readProjects} from '../lib/projects.mjs';
import {checkoutGitlinkFiles} from './app-source.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Source=require('../producers/package-support/src/modules/shared/runtime/pinned-native-build.js');
/** A build tool from the declared Homebrew formulae, then from PATH. */
export const findBuildTool=Source.findBuildTool;
export const run=(command,args,options={})=>{
 const network=['gh','curl','uv','rustup'].includes(command)||command==='git'&&args.some(arg=>['fetch','clone','submodule','checkout'].includes(arg));
 const stdio=network?(Array.isArray(options.stdio)?options.stdio.map((value,index)=>index===2&&value==='inherit'?'pipe':value):['inherit','inherit','pipe']):(options.stdio||'inherit');
 const step=()=>execFileSync(command,args,{maxBuffer:Infinity,...options,stdio});return network?retryNetwork(step):step();
};
const git=(source,args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',maxBuffer:Infinity}).trim();
/** Fetch one exact declared HTTPS source revision into a new owned directory. */
export function checkoutSource({repository,revision,destination}){
 const url=new URL(repository);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^[a-f0-9]{40}$/.test(revision||'')||!path.isAbsolute(destination||'')||fs.existsSync(destination))throw Error('Source checkout needs a public HTTPS origin, exact revision and new absolute directory.');
 run('git',['init',destination]);run('git',['-C',destination,'remote','add','origin',repository]);
 retryNetwork(()=>run('git',['-C',destination,'fetch','--depth','1','--no-tags','origin',revision]));run('git',['-C',destination,'checkout','--detach','FETCH_HEAD']);
 if(git(destination,['rev-parse','HEAD'])!==revision)throw Error('Fetched source differs from its declared revision.');
 // A tracked symlink into one of the source's own gitlinks reads that gitlink's file at the commit the
 // source records: those gitlinks, and no other, are initialized at depth 1, as init-runtime-sources does.
 const linked=[...new Set(checkoutGitlinkFiles(destination).map(row=>row.gitlink))];
 if(linked.length)run('git',['-C',destination,'submodule','update','--init','--depth','1','--',...linked]);
 return destination;
}
/** A declared source, read in place. The input step initializes its Builds gitlink from the build's
 * submodules, so the build reads that checkout at its pinned commit and fetches nothing. Name a
 * source record that has a gitlink, or a project and one of its upstreams pinned by a gitlink. */
export function declaredSource(record,upstream){
 if(typeof record==='string')record=readProjects(root,{resolvePins:false}).projects.find(project=>project.id===record)?.upstreams.find(row=>row.id===upstream)?.pin;
 const link=record&&sourceCheckout(record);if(typeof link!=='string')throw Error('A declared source names its Builds gitlink.');
 return path.join(root,link);
}
/** A declared source placed at a work path the build names, for a build whose path maps or
 * configuration expect it there: a linked worktree of the declared checkout at its pinned commit,
 * made offline. A worktree this placed earlier at that path is reused as it is. */
export function placeDeclaredSource(record,destination){
 if(!path.isAbsolute(destination||''))throw Error('Place a declared source at an absolute work path.');
 if(!fs.existsSync(path.join(destination,'.git'))){fs.mkdirSync(path.dirname(destination),{recursive:true});execFileSync('git',['-C',declaredSource(record),'worktree','add','--quiet','--detach','--force',destination,sourceRevision(record)],{stdio:['ignore','inherit','inherit']});}
 return destination;
}
/** Export pinned source before applying owned adaptations or compiling. */
export async function stageSource(source,revision,destination){
 const checked=await Source.validatePinnedSource(source,revision);
 const treeSha256=Source.stagePinnedFiles(source,checked.files,destination);
 const dependencies=git(source,['submodule','status','--recursive']).split('\n').filter(Boolean).map(line=>{
  const match=/^ ([a-f0-9]{40}) (\S+)/.exec(' '+line.trim());if(!match)throw Error('Source dependency is not pinned.');
  return {path:match[2],revision:match[1],repository:git(path.join(source,match[2]),['remote','get-url','origin'])};
 });
 return {treeSha256,dependencies};
}
/** A Python 3.13 environment in the work directory holding the exact tools of a requirements file. */
export function pythonBuildTools(work,requirements){
 const environment=path.join(work,'tools'),python=path.join(environment,'bin/python');
 if(!fs.existsSync(python))run('uv',['venv','--python','3.13',environment]);
 run('uv',['pip','install','--python',python,'--no-deps','--requirement',requirements]);
 return {python,bin:path.join(environment,'bin')};
}
/** Run a recipe file as its project's build command. The request is checked against the
 * registered build record, its command and its runner before the recipe starts; the result is printed. */
// A recipe is one build function, or {compile, assemble}: compile runs the compilers and returns its
// outputs; assemble stages, describes and seals them without compiling. A recipe with a prepare step
// runs in phases: prepare fetches and projects the declared inputs without compiling and returns where
// they are (kept in the work directory as prepared.json); `--phase compile` writes its outputs into the
// work directory; `--phase assemble` reads only those outputs and the prepared inputs. Without --phase
// the recipe prepares, runs its compile phase as a process of its own, then assembles.
export function recipeMain(meta,recipe){
 const file=fileURLToPath(meta.url);
 if(!process.argv[1]||path.resolve(process.argv[1])!==file)return;
 (async()=>{
  const {phase,...options}=buildOptions(process.argv.slice(2)),{checkBuildRequest}=await import('./build-runtime.mjs');
  const {project,build:record}=checkBuildRequest(options);
  if(path.join(root,record.command)!==file)throw Error(project.name+' builds with '+record.command+'.');
  const request={...options,version:record.version},preparedFile=path.join(options.work,'prepared.json');
  if(typeof recipe==='function'||!recipe.prepare){
   if(phase)throw Error(project.name+' has no build phases.');
   return typeof recipe==='function'?recipe(request):recipe.assemble({...request,compiled:await recipe.compile?.(request)});
  }
  if(phase)return recipe[phase]({...request,prepared:JSON.parse(fs.readFileSync(preparedFile,'utf8'))});
  const prepared=await recipe.prepare(request);
  fs.writeFileSync(preparedFile,JSON.stringify(prepared,null,1)+'\n');
  execFileSync(process.execPath,[file,...process.argv.slice(2),'--phase','compile'],{stdio:'inherit'});
  return recipe.assemble({...request,prepared});
 })().then(value=>console.log(JSON.stringify(value)),error=>{console.error(error);process.exitCode=1;});
}
export function buildOptions(args){
 const options={};for(let index=0;index<args.length;index+=2){const key=args[index]?.slice(2);if(!['project','version','arch','output','work','phase'].includes(key)||!args[index+1]||Object.hasOwn(options,key))throw Error('Use --project, --version, --arch, --output and --work, and --phase compile or assemble.');options[key]=args[index+1];}
 if(options.phase!==undefined&&!['compile','assemble'].includes(options.phase))throw Error('Use --phase compile or --phase assemble.');return options;
}
