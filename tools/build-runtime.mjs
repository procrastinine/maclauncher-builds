import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

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

export function main(args){
 const options={};for(let i=0;i<args.length;i++){
  if(args[i]==='--check'){if(options.check)throw Error('Duplicate --check.');options.check=true;continue;}
  const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['runtime','inputs'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --runtime android with --check or --inputs /absolute/path.json.');
  options[key]=args[++i];
 }
 if(!/^[a-z0-9-]+$/.test(options.runtime||'')||(!options.check&&!options.inputs)||options.check&&options.inputs)throw Error('Choose one runtime and either --check or --inputs.');
 if(options.inputs&&!path.isAbsolute(options.inputs))throw Error('Build inputs require an absolute JSON path.');
 const recipe=JSON.parse(fs.readFileSync(path.join(root,'runtimes',options.runtime,'source.json')));
 if(recipe.id!==options.runtime)throw Error('Runtime recipe identity differs.');
 const source=verifyProducer(root,recipe);
 const command=options.check?[path.join(source,recipe.checkEntry)]:[path.join(source,recipe.buildEntry),'--inputs',options.inputs];
 const result=spawnSync(process.execPath,command,{cwd:source,stdio:'inherit'});if(result.error)throw result.error;
 if(result.status!==0)throw Error('Runtime producer exited with status '+result.status);
 return {id:recipe.id,revision:recipe.revision,action:options.check?'check':'build'};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
}
