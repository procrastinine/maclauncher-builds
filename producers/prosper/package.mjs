import {addLicense,addLicenses} from '../../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {recipe,inputs,build} from './build.mjs';
const require=createRequire(import.meta.url),Native=require('../../lib/local-native.cjs');
const {validateDeclaration}=require('../../lib/declaration.cjs');
const root=path.resolve(import.meta.dirname,'../..'),json=value=>JSON.stringify(value,null,2)+'\n',sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function copy(from,to,mode=0o644){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);fs.chmodSync(to,mode);}
function filesIn(directory,prefix=''){return fs.readdirSync(path.join(directory,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{const file=path.posix.join(prefix,entry.name);if(entry.isDirectory())return filesIn(directory,file);if(!entry.isFile())throw Error('Local runtime files must be regular files.');return[file];});}
function record(directory,file){const full=path.join(directory,file),bytes=fs.readFileSync(full),result={path:file,size:bytes.length,mode:fs.statSync(full).mode&0o777,sha256:sha(bytes)};if(file==='bin/prosper-app'){result.architectures=Native.readMachOArchitectures(full);result.executionArchitecture='x86_64';}return result;}
export async function packageLocal({buildDirectory,output,version=recipe.version}={}){
 await build({check:true});
 if(!path.isAbsolute(buildDirectory||'')||!path.isAbsolute(output||'')||fs.existsSync(output)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version))throw Error('Choose an existing build, a new absolute output directory and explicit version.');
 const result=JSON.parse(fs.readFileSync(path.join(buildDirectory,'build.json')));if(result.revision!==recipe.source.revision)throw Error('The Prosper build identity differs.');
 const payload=path.join(output,'payload'),binary=path.join(payload,'bin/prosper-app');copy(result.executable,binary,0o755);
 const run=(command,args)=>execFileSync(command,args,{encoding:'utf8'});
 const changes=[];
 for(const line of run('/usr/bin/otool',['-L',binary]).split('\n').slice(1)){
  const dependency=line.trim().split(' (')[0];if(!dependency)continue;
  if(/(?:libvulkan(?:\.\d+)*|libMoltenVK(?:-scene)?)\.dylib$/.test(dependency))changes.push('-change',dependency,'@rpath/libvulkan.1.dylib');
 }
 const commands=run('/usr/bin/otool',['-l',binary]).split('\n');
 for(let index=0;index<commands.length;index++)if(commands[index].trim()==='cmd LC_RPATH'){
  const match=commands.slice(index+1,index+5).map(line=>line.match(/^\s*path (.*) \(offset /)).find(Boolean);
  if(match&&!match[1].startsWith('@'))changes.push('-delete_rpath',match[1]);
 }
 run('/usr/bin/strip',['-S',binary]);if(changes.length)run('/usr/bin/install_name_tool',[...changes,binary]);run('/usr/bin/codesign',['--force','--sign','-',binary]);
 const source=path.join(root,recipe.source.path);
 addLicenses(payload,'Prosper',source);
 addLicenses(payload,'imgui',path.join(source,'prosper/third_party/imgui'));
 addLicenses(payload,'libatrac9',path.join(source,'prosper/third_party/libatrac9'));
 addLicenses(payload,'renderdoc',path.join(source,'prosper/third_party/renderdoc'));
 addLicenses(payload,'stb',path.join(source,'prosper/third_party/stb'));
 addLicenses(payload,'SDL3',path.join(buildDirectory,'dependencies/sdl3'));
 addLicenses(payload,'SDL3 HIDAPI',path.join(buildDirectory,'dependencies/sdl3/src/hidapi'));
 addLicense(payload,'SDL3 HIDAPI',path.join(buildDirectory,'dependencies/sdl3/src/hidapi/AUTHORS.txt'));
 addLicenses(payload,'SDL3 yuv2rgb',path.join(buildDirectory,'dependencies/sdl3/src/video/yuv2rgb'));
 addLicenses(payload,'Vulkan-Headers',path.join(buildDirectory,'dependencies/vulkan-headers'));
 addLicenses(payload,'FFmpeg',path.join(buildDirectory,'dependencies/ffmpeg-macos-x64/share/ffmpeg'));
 addLicense(payload,'ProggyClean',path.join(import.meta.dirname,'licenses/ProggyClean.txt'));
 const producerInputs=['build.mjs','package.mjs','source.json','dependencies.json'].map(file=>({path:file,sha256:sha(fs.readFileSync(path.join(import.meta.dirname,file)))}));
 fs.writeFileSync(path.join(payload,'source.json'),json({schemaVersion:1,source:recipe.source,dependencies:inputs.dependencies,artifacts:inputs.artifacts,vulkanLinkInput:result.vulkanLinkInput,producerInputs}));
 const files=filesIn(payload).map(file=>record(payload,file));
 const manifest={schemaVersion:1,managerId:'prosper',version,arch:'x64',platform:'darwin',minimumMacOS:recipe.output.minimumMacOS,upstreamRevision:recipe.source.revision,
  committedAt:recipe.source.committedAt,gameArchitecture:'x86_64',executableRelative:'bin/prosper-app',runtimeFiles:{vulkan:'managed'},files};
 fs.writeFileSync(path.join(payload,'runtime.json'),json(manifest));
 const identity=record(payload,'runtime.json'),sourceFile=files.find(file=>file.path==='source.json');
 const declaration={id:'prosper',version,arch:'x64',launcherArchitectures:['arm64','x64'],minimumMacOS:manifest.minimumMacOS,directoryRelative:'prosper/'+version+'/x64',
  sourceRelative:'source.json',sourceSha256:sourceFile.sha256,manifestRelative:'runtime.json',manifestSha256:identity.sha256,files:[...files,identity]};
 validateDeclaration(declaration);fs.writeFileSync(path.join(output,'declaration.json'),json(declaration));
 return{payload,declaration:path.join(output,'declaration.json')};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{const options={};for(let i=2;i<process.argv.length;i+=2){const key={'--build-dir':'buildDirectory','--output':'output','--version':'version'}[process.argv[i]];if(!key||!process.argv[i+1])throw Error('Use --build-dir, --output and --version.');options[key]=process.argv[i+1];}console.log(json(await packageLocal(options)));}catch(error){console.error(error.message);process.exitCode=1;}}
