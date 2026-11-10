import {sourceCheckout,sourceRevision} from '../lib/pins.mjs';
import './producer-environment.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {resolveProject,buildRecord,buildRecords} from '../lib/projects.mjs';
import {buildReleaseVersion as releaseVersion} from '../lib/package-version.mjs';
import {linuxToolSelection} from './build-tools.mjs';
import {HOSTED_RUNNERS,hostedRunner} from '../lib/hosted-runners.mjs';
import {RUST_TOOLCHAIN} from './rust-build.mjs';
import {runtimeBuildEnvironment} from './runtime-build-environment.mjs';
import {prepareBuildHost,assertBuildHost} from './build-host.mjs';
import {initializeSources} from './init-runtime-sources.mjs';
import {resolveLocks} from './build-locks.mjs';
import {publicDeclaration} from './runtime-package.mjs';
import {sealBuildInputReport} from './seal-build-input-report.mjs';
import {preparePackageLayout} from './package-layout.mjs';
import {reproducibleEnvironment} from '../lib/reproducible-build.mjs';

const root=path.resolve(import.meta.dirname,'..');
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{maxBuffer:Infinity,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

export function verifyProducer(directory,recipe){
 directory=fs.realpathSync(directory);
 if(!recipe||recipe.schemaVersion!==1||!/^[a-z0-9-]+$/.test(recipe.id||'')||
  !/^sources\/[a-z0-9-]+$/.test(sourceCheckout(recipe))||
  recipe.buildEntry!=='tools/build.mjs'||recipe.checkEntry!=='tools/check-sources.mjs')throw Error('Invalid runtime producer recipe.');
 const checkout=sourceCheckout(recipe),source=path.join(directory,checkout);
 if(!fs.existsSync(path.join(source,'.git')))throw Error('Initialize the pinned runtime source submodule before building.');
 for(const entry of [recipe.buildEntry,recipe.checkEntry]){
  const file=path.join(source,entry);if(fs.realpathSync(file)!==file||!fs.statSync(file).isFile())throw Error('Runtime producer entry must be an original regular file.');
 }
 return source;
}

// Default hosted Mac images. A recipe may select another standard hosted image
// for data or guest-code outputs through its architecture-to-runner map.
export const RUNNERS=Object.freeze({arm64:'xcode-27',x64:'macos-26-intel',universal:'xcode-27'});
export {HOSTED_RUNNERS};
export const HOST_TOOLCHAINS=Object.freeze(Object.fromEntries(Object.entries(HOSTED_RUNNERS).filter(([,host])=>host.developerDirectory).map(([label,{os,cpu,...toolchain}])=>[label,Object.freeze(toolchain)])));
export const runnerFor=(build,arch)=>build.runners?.[arch]||RUNNERS[arch];

function githubBuild(id,directory,version){
 const project=resolveProject(id,directory,{resolvePins:false});
 if(!project.build)throw Error(project.name+' has no GitHub build command. Its producer entries are '+(project.producer.entries||[project.producer.recipe]).filter(Boolean).join(', ')+'.');
 const records=buildRecords(project);
 if(version!==undefined&&!records.some(build=>build.version===version))throw Error(project.name+' builds version '+records.map(build=>build.version).join(' or ')+'.');
 return {project,build:buildRecord(project,version)};
}

const matrixRow=(project,build,arch)=>{
 const runner=runnerFor(build,arch),host=hostedRunner(runner);
 if(host.os==='linux')linuxToolSelection(build.tools||[]);
 return {project:project.id,version:build.version,arch,runner};
};

/** Manual Runtime build: the registered version of one project. `all` selects every
 * architecture it builds; release selection refuses versions that are already published. */
export function buildPlan({project:id,arch='all',version,directory=root}){
 const {project,build}=githubBuild(id,directory,version);
 if(version===undefined&&Array.isArray(project.build)){
  const records=buildRecords(project).filter(build=>arch==='all'||build.architectures.includes(arch));
  if(!records.length)throw Error(project.name+' has no declared '+arch+' build.');
  return {include:records.flatMap(build=>buildPlan({project:id,arch,version:build.version,directory}).include)};
 }
 if(version!==undefined&&version!==build.version)throw Error(project.name+' builds version '+build.version+' on GitHub.');
 releaseVersion(project.id,build.version,directory);
 const selected=arch==='all'?build.architectures:[arch];
 if(selected.some(value=>!build.architectures.includes(value)))throw Error(project.name+' builds '+build.architectures.join(' and ')+' packages on GitHub.');
 return {include:selected.map(value=>matrixRow(project,build,value))};
}

/** Registered GitHub builds in a registry snapshot, read through `read(relativePath)`. */
export function declaredBuilds(read){
 const manifest=JSON.parse(read('projects.json')),files=manifest.registries?Object.values(manifest.registries):[];
 const builds=new Map();for(const file of files)for(const project of JSON.parse(read(file)))if(project.build)for(const build of buildRecords(project))builds.set(project.id+'@'+build.version,{...build,project:project.id});
 return builds;
}

/** A build output holds the finished runtime in payload/ and its package declaration. */
export function checkBuildOutput({project,arch,output}){
 const declaration=publicDeclaration(JSON.parse(fs.readFileSync(path.join(output,'declaration.json'))));
 return {id:project.id,version:declaration.version,arch,payload:path.join(output,'payload'),declaration:path.join(output,'declaration.json')};
}

/** Prepare one declared version and architecture on its selected hosted image. */
export function prepareBuild({project:id,arch,version,directory=root,environment=process.env,initialize=initializeSources,locks=resolveLocks,...hostOptions}){
 const {project,build}=githubBuild(id,directory,version);
 if(Array.isArray(project.build)&&version===undefined)throw Error('Select one declared build version with --version.');
 if(!build.architectures.includes(arch))throw Error(project.name+' builds '+build.architectures.join(' and ')+' packages on GitHub.');
 const runner=runnerFor(build,arch),host=hostedRunner(runner);
 if(host.os==='linux')linuxToolSelection(build.tools||[]);
 const prepared=prepareBuildHost({build,label:runner,runner:host,rustToolchain:RUST_TOOLCHAIN,environment,...hostOptions});
 const env={...environment,...prepared.env,PATH:[...prepared.paths,environment.PATH].filter(Boolean).join(path.delimiter)};
 const {initialized}=initialize({project:project.id,version:build.version,directory,run:(args,cwd)=>execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity})});
 // The declared package-manager locks are fetched here, into the caches the compile reads offline.
 const resolved=locks({project:project.id,locks:build.locks,directory,env});
 if(environment.GITHUB_ENV)fs.appendFileSync(environment.GITHUB_ENV,Object.entries(prepared.env).map(([key,value])=>key+'='+value+'\n').join(''));
 if(environment.GITHUB_PATH&&prepared.paths.length)fs.appendFileSync(environment.GITHUB_PATH,prepared.paths.join('\n')+'\n');
 return {project:project.id,version:build.version,arch,runner,...prepared,initialized,locks:resolved};
}

/** Validate the declared version and CPU, output/work paths and execution host. */
export function checkBuildRequest({project:id,arch,version,output,work,directory=root,platform=process.platform,cpu=process.arch}){
 const {project,build}=githubBuild(id,directory,version);
 if(Array.isArray(project.build)&&version===undefined)throw Error('Select one declared build version with --version.');
 if(!build.architectures.includes(arch))throw Error(project.name+' builds '+build.architectures.join(' and ')+' packages on GitHub.');
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||work===output||work.startsWith(output+path.sep)||output.startsWith(work+path.sep))throw Error('Choose a new absolute output directory and a separate absolute work directory.');
 const runner=runnerFor(build,arch),host=hostedRunner(runner);assertBuildHost(runner,host,{platform,cpu});return {project,build,runner,host};
}

/** Run the project's registered GitHub build command for one architecture. With materialize,
 * the command runs in <work>/tree, which holds only the project's build definition, and
 * receives <work>/build as its work directory. */
export function runBuild({project:id,arch,version,output,work=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-build-')),'work'),directory=root,spawn=spawnSync,platform,cpu,materialize=false}){
 const {project,build}=checkBuildRequest({project:id,arch,version,output,work,directory,platform,cpu});
 if(materialize)fs.mkdirSync(work,{recursive:true});
 // Loaded only here: a build's own definition holds this file, not the materializer.
 const source=materialize?createRequire(import.meta.url)('./materialize-build.mjs').materializeBuild({project:project.id,directory,tree:path.join(fs.realpathSync(work),'tree')}).tree:directory,recipeWork=materialize?path.join(work,'build'):work;
 const command=path.join(source,build.command),actual=fs.realpathSync(command);
 if(actual!==command||!fs.statSync(actual).isFile())throw Error('The GitHub build command must be a regular file in this repository.');
 const context=runtimeBuildEnvironment(build);
 try{
  const result=spawn(process.execPath,[command,'--project',project.id,'--arch',arch,'--version',build.version,'--output',output,'--work',recipeWork],{cwd:source,stdio:'inherit',env:reproducibleEnvironment(context.env)});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(project.name+' build exited with status '+result.status);
  sealBuildInputReport({project:project.id,output});
  const declarationFile=path.join(output,'declaration.json'),declaration=JSON.parse(fs.readFileSync(declarationFile));
  preparePackageLayout({input:path.join(output,'payload'),declaration});
  fs.writeFileSync(declarationFile,JSON.stringify(declaration,null,2)+'\n');
  return checkBuildOutput({project,arch,output});
 }finally{context.dispose();}
}

export function main(args,directory=root){
 const options={};for(let i=0;i<args.length;i++){
  if(['--check','--plan','--prepare','--materialize'].includes(args[i])){const key=args[i].slice(2);if(options[key])throw Error('Duplicate '+args[i]+'.');options[key]=true;continue;}
  const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['project','runtime','inputs','arch','output','work','version'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project android with --check or --inputs /absolute/path.json.');
  options[key]=args[++i];
 }
 if(options.project&&options.runtime)throw Error('Select one project.');options.project??=options.runtime;
 if(options.materialize&&!options.output)throw Error('Use --materialize with --project, --arch and --output.');
 if(options.prepare){
  if(options.check||options.plan||options.inputs||options.output||options.work||!options.project||!options.arch)throw Error('Use --prepare with --project, --arch and an optional --version.');
  return prepareBuild({project:options.project,arch:options.arch,version:options.version,directory});
 }
 if(options.plan){
  if(options.check||options.inputs||options.output||options.work||!options.project)throw Error('Use --plan with --project and optional --arch and --version.');
  return buildPlan({...options,directory});
 }
 if(options.arch||options.output){
  if(options.check||options.inputs||!options.arch||!options.output)throw Error('Use --project, --arch and --output, with an optional --work directory.');
  return runBuild({...options,directory});
 }
 if(!/^[a-z0-9-]+$/.test(options.project||'')||(!options.check&&!options.inputs)||options.check&&options.inputs)throw Error('Choose one project and either --check or --inputs.');
 if(options.inputs&&!path.isAbsolute(options.inputs))throw Error('Build inputs require an absolute JSON path.');
 const project=resolveProject(options.project,directory);
 const adapter=project.producer.kind==='maclauncher'&&project.producer.buildEntry;
 if(project.producer.kind==='maclauncher'&&!adapter&&project.producer.sourceDirectory){
  const repository=fs.realpathSync(directory);
  for(const entry of project.producer.entries){
   const file=path.join(directory,entry),actual=fs.realpathSync(file),stat=fs.statSync(actual);
   if(!actual.startsWith(repository+path.sep)||!(stat.isFile()||stat.isDirectory()))throw Error('Producer source entries must be contained regular files or directories.');
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
 return {id:project.id,revision:sourceRevision(recipe,directory),action:options.check?'check':'build'};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
}
