import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url),B=require('../../lib/bundled-native.cjs');
const Native=require('../../lib/local-native.cjs');
const producer=import.meta.dirname,pin=JSON.parse(fs.readFileSync(path.join(producer,'source.json')));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const run=(tool,args)=>execFileSync(tool,args,{stdio:'inherit'});
const mutableInputs=new Set(['source.json','runtime/bootstrap.c','runtime/nxnative.py','runtime/metal-toolchain.m','package.mjs','refresh-runtime.mjs']);

function producerInputs(root=producer,prefix=''){
 return fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
  if(entry.name.startsWith('.'))return [];
  const relative=path.posix.join(prefix,entry.name),file=path.join(root,entry.name);
  if(entry.isDirectory())return producerInputs(file,relative);
  if(!entry.isFile())throw Error('Producer inputs must be regular files.');
  return [{path:relative,sha256:digest(fs.readFileSync(file))}];
 });
}

export function refreshRuntime({input,output,version=pin.version}){
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Runtime refresh requires Apple Silicon macOS.');
 if(!path.isAbsolute(input||'')||!path.isAbsolute(output||''))throw Error('Use absolute input/output directories.');
 input=fs.realpathSync(input);
 if(output===input||output.startsWith(input+path.sep)||fs.existsSync(output))throw Error('Select a new immutable output directory.');
 const bytes=fs.readFileSync(path.join(input,'manifest.json'));
 const manifest=B.validateManifest(JSON.parse(bytes));
 if(![pin.id,...(pin.previousRuntimeIds||[])].includes(manifest.managerId))throw Error('The base runtime belongs to another project.');
 B.verifyPayload(input,{files:[...manifest.files,{path:'manifest.json',size:bytes.length,mode:0o644,sha256:digest(bytes)}]});
 const origins=JSON.parse(fs.readFileSync(path.join(input,'source.json')));
 const runtime=JSON.parse(fs.readFileSync(path.join(input,'runtime.json')));
 if(JSON.stringify(origins.source)!==JSON.stringify(pin.source)||manifest.arch!==pin.architecture||manifest.minimumMacOS!==pin.minimumMacOS||manifest.executableRelative!==pin.output.executableRelative||runtime.runtimeFiles.host!==pin.output.hostRelative)
  throw Error('The base runtime is incompatible with the current source pin or platform.');
 const owned=producerInputs(),previous=new Map(origins.producerInputs.map(file=>[file.path,file.sha256]));
 for(const file of owned){
  if(!mutableInputs.has(file.path)&&previous.get(file.path)!==file.sha256)throw Error('A full build is required for the changed producer input: '+file.path);
  previous.delete(file.path);
 }
 if([...previous.keys()].some(file=>!mutableInputs.has(file)))throw Error('A full build is required for removed producer inputs.');
 if(version===manifest.version)throw Error('Runtime refresh requires a new version.');
 fs.mkdirSync(output,{recursive:true});
 for(const file of manifest.files){
  const destination=path.join(output,file.path);fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.copyFileSync(path.join(input,file.path),destination,fs.constants.COPYFILE_FICLONE);fs.chmodSync(destination,file.mode);
 }
 const executable=path.join(output,pin.output.executableRelative);
 run('/usr/bin/clang',['-arch',pin.architecture,'-mmacosx-version-min='+pin.minimumMacOS,'-O2','-ffile-prefix-map='+producer+'=/nxnative-producer',path.join(producer,'runtime/bootstrap.c'),'-o',executable]);
 run('/usr/bin/strip',['-S',executable]);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',executable]);run('/usr/bin/codesign',['--verify','--strict',executable]);
 const metal=path.join(output,'bin/xcrun');
 run('/usr/bin/clang',['-arch',pin.architecture,'-mmacosx-version-min='+pin.minimumMacOS,'-fobjc-arc','-O2','-ffile-prefix-map='+producer+'=/nxnative-producer',path.join(producer,'runtime/metal-toolchain.m'),'-framework','Foundation','-o',metal]);
 run('/usr/bin/strip',['-S',metal]);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',metal]);run('/usr/bin/codesign',['--verify','--strict',metal]);
 fs.copyFileSync(path.join(producer,'runtime/nxnative.py'),path.join(output,'runtime/nxnative.py'));fs.chmodSync(path.join(output,'runtime/nxnative.py'),0o644);
 const reusedPayload={id:manifest.managerId,version:manifest.version,manifestSha256:digest(bytes)};
 runtime.id=pin.id;runtime.version=version;json(path.join(output,'runtime.json'),runtime);
 origins.id=pin.id;origins.version=version;origins.producerInputs=owned;origins.reusedPayload=reusedPayload;json(path.join(output,'source.json'),origins);
 manifest.managerId=pin.id;manifest.version=version;manifest.provenance={...manifest.provenance,producerInputs:owned,reusedPayload};
 manifest.files=manifest.files.map(file=>{
  const full=path.join(output,file.path),stat=fs.statSync(full),architectures=file.path===pin.output.executableRelative?Native.readMachOArchitectures(full,{allowLibrary:true}):file.architectures;
  return {path:file.path,size:stat.size,mode:stat.mode&0o777,sha256:digest(fs.readFileSync(full)),...(architectures?{architectures}:{})};
 });
 B.validateManifest(manifest);B.verifyPayload(output,manifest);json(path.join(output,'manifest.json'),manifest);
 return {id:pin.id,version,output,reusedPayload};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const options={};for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index]?.slice(2),value=process.argv[index+1];if(!['input','output','version'].includes(key)||!value)throw Error('Use --input, --output and optional --version.');options[key]=value;}
 try{console.log(JSON.stringify(refreshRuntime(options)));}catch(error){console.error(error.message);process.exitCode=1;}
}
