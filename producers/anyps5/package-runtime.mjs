import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack} from '../../tools/runtime-package.mjs';
import {assetName} from '../../lib/project-identity.mjs';
import {buildRuntime} from './build-runtime.mjs';

const require=createRequire(import.meta.url),Native=require('../../lib/local-native.cjs');
const root=path.resolve(import.meta.dirname,'../..');
const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json')));
const dependencies=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'dependencies.json')));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
function copy(from,to,mode=0o644){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);fs.chmodSync(to,mode);}
function filesIn(directory,prefix=''){
 return fs.readdirSync(path.join(directory,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  const relative=path.posix.join(prefix,entry.name);if(entry.isDirectory())return filesIn(directory,relative);
  if(!entry.isFile())throw Error('Runtime package inputs must be regular files: '+relative);return [relative];
 });
}
function record(directory,relative){
 const file=path.join(directory,relative),bytes=fs.readFileSync(file),result={path:relative,size:bytes.length,mode:fs.statSync(file).mode&0o777,sha256:sha(bytes)};
 try{result.architectures=Native.readMachOArchitectures(file,{allowLibrary:true});}catch(error){
  if(relative.startsWith('libs/')||relative==='tools/relinker')throw error;
 }
 if(result.architectures?.includes('x86_64')&&!result.architectures.includes('arm64'))result.executionArchitecture='x86_64';
 return result;
}
function makePortable(libraries){
 const entries=fs.readdirSync(libraries).filter(name=>/\.(prx|dylib)$/.test(name));
 if(!entries.includes('libc.prx')||!entries.includes('libSceAgcDriver.prx')||!entries.includes('libkernel.prx'))throw Error('The AnyPS5 runtime library build is incomplete.');
 const names=new Set(entries);
 for(const name of entries){
  const file=path.join(libraries,name),architectures=Native.readMachOArchitectures(file,{allowLibrary:true});
  if(architectures.length!==1||architectures[0]!=='x86_64')throw Error('AnyPS5 game libraries require x86-64: '+name);
  const changes=['-id','@rpath/'+name];
  for(const line of run('/usr/bin/otool',['-L',file]).split('\n').slice(1)){
   const dependency=line.trim().split(' (')[0];if(!dependency)continue;
   if(names.has(path.basename(dependency)))changes.push('-change',dependency,'@rpath/'+path.basename(dependency));
   else if(!dependency.startsWith('/usr/lib/')&&!dependency.startsWith('/System/Library/'))throw Error('Unpackaged AnyPS5 dependency: '+dependency);
  }
  run('/usr/bin/strip',['-S',file]);
  run('/usr/bin/install_name_tool',[...changes,file]);
  run('/usr/bin/codesign',['--force','--sign','-',file]);
 }
}
export async function packageRuntime({runtimeBuild,relinkerBuild,output,version}){
 await buildRuntime({check:true});
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version||'')||!output||fs.existsSync(output))throw Error('Choose a new output directory and explicit package version.');
 const libraryRoot=path.join(runtimeBuild,'build/core/libs/libs'),relinker=path.join(relinkerBuild,'core/relinker/relinker');
 const executableArchitectures=Native.readMachOArchitectures(relinker);
 if(!executableArchitectures.includes('arm64'))throw Error('The relinker must support ARM64.');
 fs.mkdirSync(output,{recursive:true});const payload=path.join(output,'payload');fs.mkdirSync(payload);
 copy(relinker,path.join(payload,'tools/relinker'),0o755);
 run('/usr/bin/strip',['-S',path.join(payload,'tools/relinker')]);
 run('/usr/bin/codesign',['--force','--sign','-',path.join(payload,'tools/relinker')]);
 copy(path.join(import.meta.dirname,'tools/unwrap-self.cjs'),path.join(payload,'tools/unwrap-self.cjs'));
 for(const name of fs.readdirSync(libraryRoot).filter(name=>/\.(prx|dylib)$/.test(name)&&fs.lstatSync(path.join(libraryRoot,name)).isFile()))copy(path.join(libraryRoot,name),path.join(payload,'libs',name),0o755);
 makePortable(path.join(payload,'libs'));
 const source=path.join(root,recipe.source.path),notices=[];
 for(const entry of [{path:'',id:'anyps5',repository:recipe.source.repository,license:'GPL-2.0-only'},...dependencies.dependencies.map(entry=>({...entry,id:entry.path.replaceAll('/','-'),license:'See notice'}))]){
  const directory=path.join(source,entry.path),names=fs.readdirSync(directory).filter(name=>/^(?:LICENSE|COPYING|COPYRIGHT)(?:[._-].*)?$/i.test(name)&&fs.statSync(path.join(directory,name)).isFile());
  for(const name of names){const relative=path.posix.join('notices',entry.id,name);copy(path.join(directory,name),path.join(payload,relative));notices.push({name:entry.id,license:entry.license,path:relative,sourceUrl:entry.repository});}
 }
 const ffmpeg=path.join(runtimeBuild,'dependencies/ffmpeg-macos-x64/share/ffmpeg');
 for(const relative of filesIn(ffmpeg).filter(relative=>relative!=='build-log.txt'))copy(path.join(ffmpeg,relative),path.join(payload,'notices/ffmpeg',relative));
 notices.push({name:'FFmpeg',license:'See notice',path:'notices/ffmpeg/copyright',sourceUrl:dependencies.artifacts[0].repository});
 const overlays=filesIn(path.join(import.meta.dirname,'overlays')).map(relative=>({path:'overlays/'+relative,sha256:sha(fs.readFileSync(path.join(import.meta.dirname,'overlays',relative)))}));
 const tools=[{path:'tools/unwrap-self.cjs',sha256:sha(fs.readFileSync(path.join(import.meta.dirname,'tools/unwrap-self.cjs')))}];
 const producerInputs=[...['build-relinker.mjs','build-runtime.mjs','source-projection.mjs','package-runtime.mjs','source.json','dependencies.json']
  .map(relative=>({path:relative,sha256:sha(fs.readFileSync(path.join(import.meta.dirname,relative)))})),...overlays,...tools].sort((a,b)=>a.path.localeCompare(b.path));
 fs.writeFileSync(path.join(payload,'source.json'),json({schemaVersion:1,source:recipe.source,dependencies:dependencies.dependencies,artifacts:dependencies.artifacts,overlays,tools,producerInputs}));
 const files=filesIn(payload).map(relative=>record(payload,relative));
 const manifest={schemaVersion:1,managerId:'anyps5',version,platform:'darwin',arch:'arm64',minimumMacOS:'26.0',upstreamRevision:recipe.source.revision,
  gameArchitecture:'x86_64',capabilities:{mouseRouting:true,touchPadBinding:true},provenance:{sourceUrl:recipe.source.repository,sourceRevision:recipe.source.revision,producerInputs},executableRelative:'tools/relinker',runtimeFiles:{libraries:'libs',unwrap:'tools/unwrap-self.cjs'},files,notices};
 fs.writeFileSync(path.join(payload,'runtime.json'),json(manifest));
 const manifestFile=record(payload,'runtime.json'),sourceFile=files.find(file=>file.path==='source.json');
 const declaration={id:'anyps5',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:manifest.minimumMacOS,directoryRelative:'anyps5/'+version+'/arm64',
  sourceRelative:'source.json',sourceSha256:sourceFile.sha256,manifestRelative:'runtime.json',manifestSha256:manifestFile.sha256,files:[...files,manifestFile],notices,redistribution:'bundle'};
 fs.writeFileSync(path.join(output,'declaration.json'),json(declaration));
 const archive=path.join(output,assetName(declaration));
 const result=await pack({project:'anyps5',input:payload,declaration,output:archive});
 return {archive,record:result};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{
  const options={};for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index],value=process.argv[index+1];if(!value||!['--runtime-build','--relinker-build','--output','--version'].includes(key))throw Error('Use --runtime-build, --relinker-build, --output and --version.');options[{'--runtime-build':'runtimeBuild','--relinker-build':'relinkerBuild','--output':'output','--version':'version'}[key]]=value;}
  console.log(json(await packageRuntime(options)));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
