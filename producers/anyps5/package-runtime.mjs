import {appRequire} from '../../tools/app-source.mjs';
import {gitlink,sourceRevision} from '../../lib/pins.mjs';
import {addLicense,addLicenses} from '../../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack} from '../../tools/runtime-package.mjs';
import {assetName} from '../../lib/project-identity.mjs';
import {buildRuntime} from './build-runtime.mjs';

const require=createRequire(import.meta.url),Native=appRequire('src/modules/shared/runtime/local-native.js');
const root=path.resolve(import.meta.dirname,'../..');
const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json')));
recipe.source.revision=gitlink(recipe.source.path);
const {inputs:dependencies}=await import('./source-projection.mjs');
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
 const names=new Set(entries);
 for(const name of entries){
  const file=path.join(libraries,name),architectures=Native.readMachOArchitectures(file,{allowLibrary:true});
  const changes=['-id','@rpath/'+name];
  for(const line of run('/usr/bin/otool',['-L',file]).split('\n').slice(1)){
   const dependency=line.trim().split(' (')[0];if(!dependency)continue;
   if(names.has(path.basename(dependency)))changes.push('-change',dependency,'@rpath/'+path.basename(dependency));
  }
  run('/usr/bin/strip',['-S',file]);
  run('/usr/bin/install_name_tool',[...changes,file]);
  run('/usr/bin/codesign',['--force','--sign','-',file]);
 }
}
export async function packageRuntime({runtimeBuild,relinkerBuild,output,version,arch=recipe.output.architecture,buildOutput=false}){
 await buildRuntime({check:true});
 if(!['arm64','x64'].includes(arch))throw Error('Select an arm64 or x64 AnyPS5 package.');
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version||'')||!output||fs.existsSync(output))throw Error('Choose a new output directory and explicit package version.');
 const libraryRoot=path.join(runtimeBuild,'build/core/libs/libs'),relinker=path.join(relinkerBuild,'core/relinker/relinker');
 fs.mkdirSync(output,{recursive:true});const payload=path.join(output,'payload');fs.mkdirSync(payload);
 copy(relinker,path.join(payload,'tools/relinker'),0o755);
 run('/usr/bin/strip',['-S',path.join(payload,'tools/relinker')]);
 run('/usr/bin/codesign',['--force','--sign','-',path.join(payload,'tools/relinker')]);
 copy(path.join(import.meta.dirname,'tools/unwrap-self.cjs'),path.join(payload,'tools/unwrap-self.cjs'));
 for(const name of fs.readdirSync(libraryRoot).filter(name=>/\.(prx|dylib)$/.test(name)&&fs.lstatSync(path.join(libraryRoot,name)).isFile()))copy(path.join(libraryRoot,name),path.join(payload,'libs',name),0o755);
 makePortable(path.join(payload,'libs'));
 const source=path.join(root,recipe.source.path);
 addLicenses(payload,'anyps5',source);
 addLicense(payload,'AnyPS5-ARM',path.join(import.meta.dirname,'licenses/AnyPS5-ARM.txt'));
 for(const entry of dependencies.dependencies)addLicenses(payload,entry.path,path.join(source,entry.path));
 addLicense(payload,'FreeType',path.join(source,'3rdparty/freetype/docs/FTL.TXT'));
 addLicense(payload,'FreeType',path.join(source,'3rdparty/freetype/docs/GPLv2.TXT'));
 addLicense(payload,'libjpeg-turbo',path.join(source,'3rdparty/libjpeg-turbo/README.ijg'));
 const overlays=filesIn(path.join(import.meta.dirname,'overlays')).map(relative=>({path:'overlays/'+relative,sha256:sha(fs.readFileSync(path.join(import.meta.dirname,'overlays',relative)))}));
 const tools=[{path:'tools/unwrap-self.cjs',sha256:sha(fs.readFileSync(path.join(import.meta.dirname,'tools/unwrap-self.cjs')))}];
 const producerInputs=[...['build-relinker.mjs','build-runtime.mjs','source-projection.mjs','package-runtime.mjs','source.json','dependencies.json']
  .map(relative=>({path:relative,sha256:sha(fs.readFileSync(path.join(import.meta.dirname,relative)))})),...overlays,...tools].sort((a,b)=>a.path.localeCompare(b.path));
 fs.writeFileSync(path.join(payload,'source.json'),json({schemaVersion:1,source:recipe.source,attributions:recipe.attributions,dependencies:dependencies.dependencies,artifacts:dependencies.artifacts,overlays,tools,producerInputs}));
 const files=filesIn(payload).map(relative=>record(payload,relative));
 const manifest={schemaVersion:1,managerId:'anyps5',version,platform:'darwin',arch,minimumMacOS:'26.0',upstreamRevision:sourceRevision(recipe.source),
  gameArchitecture:'x86_64',capabilities:{mouseRouting:true,touchPadBinding:true},provenance:{sourceUrl:recipe.source.repository,sourceRevision:sourceRevision(recipe.source),producerInputs},executableRelative:'tools/relinker',runtimeFiles:{libraries:'libs',unwrap:'tools/unwrap-self.cjs'},files};
 fs.writeFileSync(path.join(payload,'runtime.json'),json(manifest));
 const manifestFile=record(payload,'runtime.json'),sourceFile=files.find(file=>file.path==='source.json');
 const declaration={id:'anyps5',version,arch,launcherArchitectures:[arch],minimumMacOS:manifest.minimumMacOS,directoryRelative:'anyps5/'+version+'/'+arch,
  sourceRelative:'source.json',sourceSha256:sourceFile.sha256,manifestRelative:'runtime.json',manifestSha256:manifestFile.sha256,files:[...files,manifestFile],redistribution:'bundle'};
 fs.writeFileSync(path.join(output,'declaration.json'),json(declaration));
 if(buildOutput)return {output,declaration};
 const archive=path.join(output,assetName(declaration));
 const result=await pack({project:'anyps5',input:payload,declaration,output:archive});
 return {archive,record:result};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{
  const options={};for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index],value=process.argv[index+1];if(!value||!['--runtime-build','--relinker-build','--output','--version','--arch'].includes(key))throw Error('Use --runtime-build, --relinker-build, --output, --version and --arch.');options[{'--runtime-build':'runtimeBuild','--relinker-build':'relinkerBuild','--output':'output','--version':'version','--arch':'arch'}[key]]=value;}
  console.log(json(await packageRuntime(options)));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
