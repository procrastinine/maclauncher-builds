import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {pack,catalog} from '../../tools/runtime-package.mjs';
const require=createRequire(import.meta.url),Bundled=require('../../lib/bundled-native.cjs');
const producer=import.meta.dirname;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// Build-time source and interpreter inputs stay outside the runtime release.
// Only the matching producer declaration selects a new payload format.
function selectPayload(input, temporary) {
 const pinBytes=fs.readFileSync(path.join(producer,'source.json')),pin=JSON.parse(pinBytes);
 const source=JSON.parse(fs.readFileSync(path.join(input,'source.json'))),runtime=JSON.parse(fs.readFileSync(path.join(input,'runtime.json')));
 const matched=source.producerInputs?.some(file=>file.path==='source.json'&&file.sha256===digest(pinBytes));
 const python=matched?pin.runtimePython:null,external=matched?pin.runtimeSource:null,metal=matched?pin.runtimeMetal:null;
 const sharePython=python&&runtime.python?.delivery!=='launcher',splitSource=external&&runtime.sourceRequirement===undefined;
 const configureMetal=metal&&Object.entries(metal).some(([key,value])=>runtime.requirements?.metalCompiler?.[key]!==value);
 if(!sharePython&&!splitSource&&!configureMetal)return input;
 if(python&&(python.delivery!=='launcher'||python.version!=='3.12'||python.abi!=='cpython-312-darwin'||python.architecture!=='arm64'))throw Error('Unsupported shared Python ABI.');
 if(external&&(external.delivery!=='upstream'||external.repository!=='https://github.com/seedds/nxnative.git'||external.adapter!=='maclauncher-nxnative-1'))throw Error('Unsupported upstream source adapter.');
 if(metal&&(metal.delivery!=='managed'||metal.managerId!=='apple-metal-toolchain'||metal.environment!=='MCL_APPLE_METAL_TOOLCHAIN_ROOT'))throw Error('Unsupported managed Metal compiler.');
 const manifest=Bundled.validateManifest(JSON.parse(fs.readFileSync(path.join(input,'manifest.json'))));
 const wheels='python/lib/python3.12/site-packages/',translator='share/nxnative/dm/gfx/tools/dmsh_xlate_bin/';
 const selected=relative=>!(sharePython&&relative.startsWith('python/')&&!relative.startsWith(wheels))&&
  !(splitSource&&relative.startsWith('share/nxnative/')&&!relative.startsWith(translator));
 const remap=relative=>sharePython&&relative.startsWith(wheels)?'python-packages/'+relative.slice(wheels.length):
  splitSource&&relative.startsWith(translator)?'tools/shader-xlate/'+relative.slice(translator.length):relative;
 for(const file of manifest.files.filter(file=>selected(file.path))){
  const destination=path.join(temporary,remap(file.path));fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.copyFileSync(path.join(input,file.path),destination,fs.constants.COPYFILE_FICLONE);fs.chmodSync(destination,file.mode);
 }
 if(sharePython){
  if(!manifest.files.some(file=>file.path.startsWith(wheels)))throw Error('The runtime Python packages are missing.');
  runtime.python=python;delete runtime.runtimeFiles.python;runtime.runtimeFiles.pythonPackages='python-packages';source.runtimePython=python;
 }
 if(splitSource){
  const header=fs.readFileSync(path.join(input,'share/nxnative/dm/gfx/nvn/dmsh_chain.h'),'utf8');
  const shaderChain=/^#define DMSH_CHAIN\s+"([0-9a-f]{12})"/m.exec(header)?.[1];
  if(!shaderChain||!manifest.files.some(file=>file.path===translator+'dmsh_xlate'))throw Error('The native shader toolchain is missing.');
  const committed=execFileSync('git',['-C',path.resolve(producer,'../..',pin.source.path),'show','-s','--format=%cI',runtime.nativeSourceRevision],{encoding:'utf8',env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}}).trim();
  if(!Number.isFinite(Date.parse(committed)))throw Error('The native source commit timestamp is unavailable.');
  runtime.nativeSourceCommittedAt=new Date(committed).toISOString();
  runtime.sourceRequirement={repository:external.repository,nativeSourceRevision:runtime.nativeSourceRevision,adapter:external.adapter,shaderChain};
  delete runtime.sourceRevision;delete runtime.runtimeFiles.profileRoot;
  runtime.runtimeFiles.shaderTranslator='tools/shader-xlate/dmsh_xlate';runtime.runtimeFiles.shaderToolchain='runtime/shader-toolchain.json';
  const toolchain={schemaVersion:1,shaderChain,lock:fs.readFileSync(path.join(input,'share/nxnative/dm/gfx/tools/dmsh_chain.lock'),'utf8')};
  const data=Buffer.from(JSON.stringify(toolchain,null,2)+'\n');fs.writeFileSync(path.join(temporary,runtime.runtimeFiles.shaderToolchain),data);
  manifest.files.push({path:runtime.runtimeFiles.shaderToolchain,size:data.length,mode:0o644,sha256:digest(data)});
  source.sourceRequirement=runtime.sourceRequirement;source.nativeSourceCommittedAt=runtime.nativeSourceCommittedAt;
  manifest.provenance.nativeSourceCommittedAt=runtime.nativeSourceCommittedAt;
 }
 if(metal){
  runtime.requirements={...runtime.requirements,metalCompiler:{...runtime.requirements?.metalCompiler,...metal}};
  delete runtime.requirements.metalCompiler.command;
  source.runtimeMetal=metal;
 }
 fs.writeFileSync(path.join(temporary,'runtime.json'),JSON.stringify(runtime,null,2)+'\n');
 fs.writeFileSync(path.join(temporary,'source.json'),JSON.stringify(source,null,2)+'\n');
 manifest.files=manifest.files.filter(file=>selected(file.path)).map(file=>{
  const relative=remap(file.path),bytes=fs.readFileSync(path.join(temporary,relative));return{...file,path:relative,size:bytes.length,sha256:digest(bytes)};
 });
 manifest.dependencies=manifest.dependencies.filter(file=>selected(file.file)).map(file=>({...file,file:remap(file.file)}));
 Bundled.validateManifest(manifest);Bundled.verifyPayload(temporary,manifest);
 fs.writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 return temporary;
}

export async function packageNxNative({input,outputDirectory,catalogFile,buildOutput}){
 fs.mkdirSync(outputDirectory,{recursive:true});
 const temporary=fs.mkdtempSync(path.join(outputDirectory,'.nxnative-payload-'));
 try {
  const original=Bundled.validateManifest(JSON.parse(fs.readFileSync(path.join(input,'manifest.json'))));
  const pin=JSON.parse(fs.readFileSync(path.join(producer,'source.json')));
  if(![pin.id,...(pin.previousRuntimeIds||[])].includes(original.managerId))throw Error('The package belongs to another project.');
  const bytes=fs.readFileSync(path.join(input,'manifest.json'));
  Bundled.verifyPayload(input,{files:[...original.files,{path:'manifest.json',size:bytes.length,mode:0o644,sha256:digest(bytes)}]});
  input=selectPayload(input,temporary);
 const manifestBytes=fs.readFileSync(path.join(input,'manifest.json'));
 const manifest=Bundled.validateManifest(JSON.parse(manifestBytes));
 const declaration={id:manifest.managerId,version:manifest.version,arch:manifest.arch,launcherArchitectures:['arm64'],minimumMacOS:manifest.minimumMacOS,
  directoryRelative:manifest.managerId+'/'+manifest.version+'/'+manifest.arch,manifestRelative:'manifest.json',manifestSha256:digest(manifestBytes),
  sourceRelative:'source.json',sourceSha256:digest(fs.readFileSync(path.join(input,'source.json'))),
  files:[...manifest.files,{path:'manifest.json',size:manifestBytes.length,mode:0o644,sha256:digest(manifestBytes)}],notices:manifest.notices,redistribution:'bundle'};
 Bundled.verifyPayload(input,declaration);
 fs.mkdirSync(outputDirectory,{recursive:true});
 if(buildOutput){
  if(!path.isAbsolute(buildOutput)||fs.existsSync(buildOutput))throw Error('Choose a new absolute build output.');
  fs.mkdirSync(buildOutput,{recursive:true});fs.cpSync(input,path.join(buildOutput,'payload'),{recursive:true});
  fs.writeFileSync(path.join(buildOutput,'declaration.json'),JSON.stringify(declaration,null,2)+'\n');return {output:buildOutput,declaration};
 }
 const output=path.join(outputDirectory,manifest.managerId+'-'+manifest.version+'-'+manifest.arch+'.tar.gz');
 if(fs.existsSync(output)||fs.existsSync(output+'.json'))throw Error('The immutable package output already exists.');
 const record=await pack({project:manifest.managerId,input,declaration,output});
 if(catalogFile){
  if(fs.existsSync(catalogFile))throw Error('The catalog output already exists.');
  fs.writeFileSync(catalogFile,JSON.stringify(catalog([record],{project:manifest.managerId,repository:'procrastinine/maclauncher-builds'}),null,2)+'\n');
 }
 return {archive:output,record};
 } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]?.slice(2),value=process.argv[i+1];if(!['input','output','catalog'].includes(key)||!value)throw Error('Use --input, --output and optional --catalog.');options[key]=value;}
 packageNxNative({input:options.input,outputDirectory:options.output,catalogFile:options.catalog}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
