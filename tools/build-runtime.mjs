import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord,buildRecords} from '../lib/projects.mjs';
import {releaseVersion} from '../lib/package-version.mjs';
import {publicDeclaration} from './runtime-package.mjs';
const B=createRequire(import.meta.url)('../lib/bundled-native.cjs');

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

// GitHub-hosted runners for each package architecture. Each architecture builds
// on a Mac with that CPU; a universal package builds on the Apple Silicon runner.
export const RUNNERS=Object.freeze({arm64:'xcode-27',x64:'macos-26-intel',universal:'xcode-27'});

function githubBuild(id,directory,version){
 const project=resolveProject(id,directory,{resolvePins:false});
 if(!project.build)throw Error(project.name+' has no GitHub build command. Its producer entries are '+(project.producer.entries||[project.producer.recipe]).filter(Boolean).join(', ')+'.');
 const records=buildRecords(project);
 if(version!==undefined&&!records.some(build=>build.version===version))throw Error(project.name+' builds version '+records.map(build=>build.version).join(' or ')+'.');
 return {project,build:buildRecord(project,version)};
}

const matrixRow=(project,build,arch)=>({project:project.id,version:build.version,arch,runner:build.runners?.[arch]||RUNNERS[arch],submodules:(build.submodules||[]).join(' '),tools:(build.tools||[]).join(' '),rustComponents:(build.rustComponents||[]).join(' '),recursiveSubmodules:build.recursiveSubmodules===true,rustTargets:(build.rustTargets||[]).join(' ')});
const gitTags=(directory,id)=>git(directory,['tag','--list',id+'/v*']).split('\n').filter(Boolean);

/** Architectures of a version that already have a catalog record or a release tag, which a draft also has. */
function existing(project,version,directory,tags){
 const file=path.join(directory,'catalogs',project.id+'.json'),prefix=project.id+'/v'+version+'/';
 const published=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)).packages.filter(record=>record.version===version).map(record=>record.arch):[];
 return new Set([...published,...tags(directory,project.id).filter(tag=>tag.startsWith(prefix)).map(tag=>tag.slice(prefix.length))]);
}

/** Manual Runtime build: the registered version of one project. `all` selects every
 * architecture that has no catalog record or tag yet; nothing is built twice. */
export function buildPlan({project:id,arch='all',version,directory=root,tags=gitTags}){
 const {project,build}=githubBuild(id,directory,version);
 if(version===undefined&&Array.isArray(project.build)){
  const records=buildRecords(project).filter(build=>arch==='all'||build.architectures.includes(arch));
  if(!records.length)throw Error(project.name+' has no declared '+arch+' build.');
  const include=records.flatMap(build=>{try{return buildPlan({project:id,arch,version:build.version,directory,tags}).include;}catch(error){if(arch==='all'&&error.message.includes('already has a package for each'))return [];throw error;}});
  if(!include.length)throw Error(project.name+' already has a package for each declared version and architecture.');
  return {include};
 }
 if(version!==undefined&&version!==build.version)throw Error(project.name+' builds version '+build.version+' on GitHub.');
 releaseVersion(project.id,build.version,directory);
 const done=existing(project,build.version,directory,tags);
 const selected=arch==='all'?build.architectures.filter(value=>!done.has(value)):[arch];
 if(selected.some(value=>!build.architectures.includes(value)))throw Error(project.name+' builds '+build.architectures.join(' and ')+' packages on GitHub.');
 if(arch!=='all'&&done.has(arch))throw Error(project.name+' '+build.version+' already has a '+arch+' package or tag.');
 if(!selected.length)throw Error(project.name+' '+build.version+' already has a package for each architecture it builds.');
 return {include:selected.map(value=>matrixRow(project,build,value))};
}

/** Registered GitHub builds in a registry snapshot, read through `read(relativePath)`. */
export function declaredBuilds(read){
 const manifest=JSON.parse(read('projects.json')),files=manifest.registries?Object.values(manifest.registries):[];
 const builds=new Map();for(const file of files)for(const project of JSON.parse(read(file)))if(project.build)for(const build of buildRecords(project))builds.set(project.id+'@'+build.version,{...build,project:project.id});
 return builds;
}

/** Push-triggered Runtime build: only builds whose version or architectures changed
 * since `before`, minus architectures that already have a catalog record or tag. */
export function pushPlan({before,directory=root,tags=gitTags,show=(revision,file)=>git(directory,['show',revision+':'+file])}){
 if(!/^[a-f0-9]{40}$/.test(before||'')||/^0+$/.test(before))return {include:[]};
 const previous=declaredBuilds(file=>show(before,file)),include=[];
 for(const [key,next] of declaredBuilds(file=>fs.readFileSync(path.join(directory,file),'utf8'))){
  const old=previous.get(key),id=next.project;
  if(old&&old.version===next.version&&next.architectures.every(arch=>old.architectures.includes(arch)))continue;
  const {project,build}=githubBuild(id,directory,next.version),done=existing(project,build.version,directory,tags);
  for(const arch of build.architectures)if(!done.has(arch))include.push(matrixRow(project,build,arch));
 }
 return {include};
}


/** A build output holds the finished runtime in payload/ and its package declaration. */
export function checkBuildOutput({project,build,arch,output}){
 const names=fs.readdirSync(output).sort();
 if(names.join('\n')!=='declaration.json\npayload')throw Error('A build output contains only declaration.json and payload/.');
 const declaration=publicDeclaration(JSON.parse(fs.readFileSync(path.join(output,'declaration.json'))));
 if(declaration.id!==project.id||declaration.arch!==arch||declaration.version!==build.version)throw Error('The build produced a package for a different project, version or architecture.');
 // Each package serves the CPUs its code was built for. The package contract decides whether an
 // Intel package also serves Apple Silicon, which needs Intel files that run as their own processes.
 const cpus=declaration.launcherArchitectures,own=arch==='universal'?['arm64','x64']:[arch];
 if(!own.every(cpu=>cpus.includes(cpu))||arch==='arm64'&&cpus.length!==1)throw Error('The package declares Mac CPUs that differ from its architecture.');
 B.verifyPayload(path.join(output,'payload'),declaration);
 return {id:project.id,version:declaration.version,arch,payload:path.join(output,'payload'),declaration:path.join(output,'declaration.json')};
}

/** Run the project's registered GitHub build command for one architecture. */
export function runBuild({project:id,arch,version,output,work,directory=root,spawn=spawnSync}){
 const {project,build}=githubBuild(id,directory,version);
 if(Array.isArray(project.build)&&version===undefined)throw Error('Select one declared build version with --version.');
 if(!build.architectures.includes(arch))throw Error(project.name+' builds '+build.architectures.join(' and ')+' packages on GitHub.');
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||work!==undefined&&(!path.isAbsolute(work)||work===output||work.startsWith(output+path.sep)||output.startsWith(work+path.sep)))throw Error('Choose a new absolute output directory and a separate absolute work directory.');
 const command=path.join(directory,build.command),actual=fs.realpathSync(command);
 if(actual!==command||!fs.statSync(actual).isFile())throw Error('The GitHub build command must be a regular file in this repository.');
 const result=spawn(process.execPath,[command,'--project',project.id,'--arch',arch,...(Array.isArray(project.build)?['--version',build.version]:[]),'--output',output,...(work?['--work',work]:[])],{cwd:directory,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(project.name+' build exited with status '+result.status);
 return checkBuildOutput({project,build,arch,output});
}

export function main(args,directory=root){
 const options={};for(let i=0;i<args.length;i++){
  if(['--check','--plan'].includes(args[i])){const key=args[i].slice(2);if(options[key])throw Error('Duplicate '+args[i]+'.');options[key]=true;continue;}
  const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['project','runtime','inputs','arch','output','work','version','before'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project android with --check or --inputs /absolute/path.json.');
  options[key]=args[++i];
 }
 if(options.project&&options.runtime)throw Error('Select one project.');options.project??=options.runtime;
 if(options.plan){
  if(options.check||options.inputs||options.output||options.work||!options.before===!options.project||options.before&&(options.arch||options.version))throw Error('Use --plan with --before <commit>, or with --project and optional --arch and --version.');
  return options.before?pushPlan({before:options.before,directory}):buildPlan({...options,directory});
 }
 if(options.before)throw Error('--before applies to --plan.');
 if(options.arch||options.output){
  if(options.check||options.inputs||!options.arch||!options.output)throw Error('Use --project, --arch and --output, with an optional --work directory.');
  return runBuild({...options,directory});
 }
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
