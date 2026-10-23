import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolveProject} from '../lib/projects.mjs';

const root=path.resolve(import.meta.dirname,'..');
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

export function verifyProducer(directory,recipe){
 directory=fs.realpathSync(directory);
 if(!recipe||recipe.schemaVersion!==1||!/^[a-z0-9-]+$/.test(recipe.id||'')||
  !/^[a-f0-9]{40}$/.test(recipe.revision||'')||!/^sources\/[a-z0-9-]+$/.test(recipe.path||'')||
  recipe.buildEntry!=='tools/build.mjs'||recipe.checkEntry!=='tools/check-sources.mjs')throw Error('Invalid runtime producer recipe.');
 const source=path.join(directory,recipe.path),record=git(directory,['ls-tree','HEAD','--',recipe.path]);
 if(record!==`160000 commit ${recipe.revision}\t${recipe.path}`)throw Error('Producer recipe differs from the pinned source submodule.');
 if(!fs.existsSync(path.join(source,'.git')))throw Error('Initialize the pinned runtime source submodule before building.');
 if(git(source,['rev-parse','HEAD'])!==recipe.revision)throw Error('Runtime source checkout differs from its selected revision.');
 if(git(source,['status','--porcelain','--untracked-files=normal']))throw Error('Runtime source checkout has local changes.');
 for(const entry of [recipe.buildEntry,recipe.checkEntry]){
  const file=path.join(source,entry);if(fs.realpathSync(file)!==file||!fs.statSync(file).isFile())throw Error('Runtime producer entry must be an original regular file.');
 }
 return source;
}

export function main(args,directory=root){
 const options={};for(let i=0;i<args.length;i++){
  if(args[i]==='--check'){if(options.check)throw Error('Duplicate --check.');options.check=true;continue;}
  const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['project','runtime','inputs'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project android with --check or --inputs /absolute/path.json.');
  options[key]=args[++i];
 }
 if(options.project&&options.runtime)throw Error('Select one project.');options.project??=options.runtime;
 if(!/^[a-z0-9-]+$/.test(options.project||'')||(!options.check&&!options.inputs)||options.check&&options.inputs)throw Error('Choose one project and either --check or --inputs.');
 if(options.inputs&&!path.isAbsolute(options.inputs))throw Error('Build inputs require an absolute JSON path.');
 const project=resolveProject(options.project,directory);
 const adapter=project.producer.kind==='maclauncher'&&project.producer.buildEntry;
 if(project.producer.kind==='maclauncher'&&!adapter&&project.producer.sourceDirectory){
  const source=fs.realpathSync(path.join(directory,project.producer.sourceDirectory));
  for(const entry of project.producer.entries){
   const file=path.join(directory,entry),actual=fs.realpathSync(file);
   if(!actual.startsWith(source+path.sep)||!fs.statSync(actual).isFile())throw Error('Producer source entries must be contained regular files.');
  }
  if(!options.check)throw Error('Use the selected producer entry with its documented build arguments: '+project.producer.entries.join(', '));
  return {id:project.id,action:'check',sourceDirectory:project.producer.sourceDirectory,entries:project.producer.entries};
 }
 if(project.producer.kind!=='pinned-source'&&!adapter)throw Error(project.producer.kind==='prebuilt'?project.name+' retains its supplied binary.':project.name+' producer is maintained in MacLauncher: '+project.producer.entries.join(', '));
 if(adapter&&(!/^tools\/[a-z0-9-]+\.mjs$/.test(adapter)||!/^[a-z0-9-]+$/.test(project.producer.sourceProject||'')))throw Error('Invalid registered adapter build entry.');
 const sourceProject=adapter?resolveProject(project.producer.sourceProject,directory):project;
 if(sourceProject.producer.kind!=='pinned-source')throw Error('Adapter builds require a pinned source producer.');
 const recipe=JSON.parse(fs.readFileSync(path.join(directory,sourceProject.producer.recipe)));
 if(recipe.id!==sourceProject.id)throw Error('Runtime recipe identity differs from the selected source project.');
 const source=verifyProducer(directory,recipe);
 const command=adapter?[path.join(directory,adapter),'--source',source,...(options.check?['--check']:['--inputs',options.inputs])]:options.check?[path.join(source,recipe.checkEntry)]:[path.join(source,recipe.buildEntry),'--inputs',options.inputs];
 const result=spawnSync(process.execPath,command,{cwd:source,stdio:'inherit'});if(result.error)throw result.error;
 if(result.status!==0)throw Error('Runtime producer exited with status '+result.status);
 return {id:project.id,revision:recipe.revision,action:options.check?'check':'build'};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
}
