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
function record(directory,file){const full=path.join(directory,file),bytes=fs.readFileSync(full),result={path:file,size:bytes.length,mode:fs.statSync(full).mode&0o777,sha256:sha(bytes)};if(file==='bin/prosper-app'){result.architectures=Native.readMachOArchitectures(full);result.executionArchitecture='x86_64';if(JSON.stringify(result.architectures)!==JSON.stringify(['x86_64']))throw Error('Prosper requires an Intel64-bit executable.');}return result;}
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
  else if(!dependency.startsWith('/usr/lib/')&&!dependency.startsWith('/System/Library/'))throw Error('Unpackaged Prosper dependency: '+dependency);
 }
 const commands=run('/usr/bin/otool',['-l',binary]).split('\n');
 for(let index=0;index<commands.length;index++)if(commands[index].trim()==='cmd LC_RPATH'){
  const match=commands.slice(index+1,index+5).map(line=>line.match(/^\s*path (.*) \(offset /)).find(Boolean);
  if(match&&!match[1].startsWith('@'))changes.push('-delete_rpath',match[1]);
 }
 run('/usr/bin/strip',['-S',binary]);if(changes.length)run('/usr/bin/install_name_tool',[...changes,binary]);run('/usr/bin/codesign',['--force','--sign','-',binary]);run('/usr/bin/codesign',['--verify','--strict',binary]);
 const notices=[],source=path.join(root,recipe.source.path);
 const license='Prosper\nAuthor: mattias800\nSource: '+recipe.source.repository+'\nRevision: '+recipe.source.revision+'\nThe upstream revision contains no license file.\n';
 fs.mkdirSync(path.join(payload,'notices'),{recursive:true});fs.writeFileSync(path.join(payload,'notices/PROSPER.txt'),license);
 notices.push({name:'Prosper',license:'NOASSERTION',path:'notices/PROSPER.txt',sourceUrl:recipe.source.repository});
 copy(path.join(source,'README.md'),path.join(payload,'notices/Prosper-README.md'));
 notices.push({name:'Prosper README',license:'NOASSERTION',path:'notices/Prosper-README.md',sourceUrl:recipe.source.repository});
 for(const name of fs.readdirSync(path.join(source,'prosper/third_party'))){const directory=path.join(source,'prosper/third_party',name);if(!fs.statSync(directory).isDirectory()||['googletest'].includes(name))continue;for(const file of fs.readdirSync(directory).filter(file=>/^(LICENSE|COPYING|COPYRIGHT)(?:[._-].*)?$/i.test(file)&&fs.statSync(path.join(directory,file)).isFile())){const relative='notices/'+name+'/'+file;copy(path.join(directory,file),path.join(payload,relative));notices.push({name,license:'See notice',path:relative,sourceUrl:recipe.source.repository});}}
 for(const file of fs.readdirSync(path.join(buildDirectory,'dependencies/sdl3')).filter(file=>/^LICENSE/i.test(file))){const relative='notices/SDL3/'+file;copy(path.join(buildDirectory,'dependencies/sdl3',file),path.join(payload,relative));notices.push({name:'SDL3',license:'Zlib',path:relative,sourceUrl:inputs.dependencies[0].repository});}
 const dependencyNotice=(directory,file,name,license,repository)=>{
  const relative='notices/'+name+'/'+file;copy(path.join(directory,file),path.join(payload,relative));notices.push({name,license,path:relative,sourceUrl:repository});
 };
 const headers=path.join(buildDirectory,'dependencies/vulkan-headers');
 for(const file of ['LICENSE.md','LICENSES/Apache-2.0.txt','LICENSES/MIT.txt'])dependencyNotice(headers,file,'Vulkan-Headers','Apache-2.0 OR MIT',inputs.dependencies.find(row=>row.id==='vulkan-headers').repository);
 const sdl=path.join(buildDirectory,'dependencies/sdl3');
 for(const file of ['LICENSE.txt','LICENSE-bsd.txt','LICENSE-orig.txt','LICENSE-gpl3.txt','AUTHORS.txt'])dependencyNotice(path.join(sdl,'src/hidapi'),file,'SDL3-HIDAPI','BSD-3-Clause OR HIDAPI original OR GPL-3.0',inputs.dependencies[0].repository);
 dependencyNotice(path.join(sdl,'src/video/yuv2rgb'),'LICENSE','SDL3-yuv2rgb','BSD-3-Clause',inputs.dependencies[0].repository);
 const fontSource=fs.readFileSync(path.join(source,'prosper/third_party/imgui/src/imgui_draw.cpp'),'utf8'),fontNotice=fontSource.match(/^\/\/ ProggyClean\.ttf\n(?:\/\/.*\n){3}/m)?.[0];
 if(!fontNotice||!fontNotice.includes('Tristan Grimmer')||!fontNotice.includes('MIT license'))throw Error('Embedded font notice differs from the pinned source.');
 const fontLicense=fontNotice.replace(/^\/\/ ?/gm,'')+'\n'+fs.readFileSync(path.join(source,'prosper/third_party/imgui/LICENSE'),'utf8');
 writeFontNotice();
 function writeFontNotice(){const relative='notices/ProggyClean/NOTICE.txt';fs.mkdirSync(path.dirname(path.join(payload,relative)),{recursive:true});fs.writeFileSync(path.join(payload,relative),fontLicense);notices.push({name:'ProggyClean',license:'MIT',path:relative,sourceUrl:recipe.source.repository});}

 const codecs=path.join(buildDirectory,'dependencies/ffmpeg-macos-x64/share/ffmpeg');
 for(const file of filesIn(codecs).filter(file=>file!=='build-log.txt'))copy(path.join(codecs,file),path.join(payload,'notices/ffmpeg',file));
 notices.push({name:'FFmpeg',license:'See notice',path:'notices/ffmpeg/copyright',sourceUrl:inputs.artifacts[0].repository});
 const producerInputs=['build.mjs','package.mjs','source.json','dependencies.json'].map(file=>({path:file,sha256:sha(fs.readFileSync(path.join(import.meta.dirname,file)))}));
 fs.writeFileSync(path.join(payload,'source.json'),json({schemaVersion:1,source:recipe.source,dependencies:inputs.dependencies,artifacts:inputs.artifacts,vulkanLinkInput:result.vulkanLinkInput,producerInputs}));
 const files=filesIn(payload).map(file=>record(payload,file));
 const manifest={schemaVersion:1,managerId:'prosper',version,arch:'x64',platform:'darwin',minimumMacOS:recipe.output.minimumMacOS,upstreamRevision:recipe.source.revision,
  committedAt:recipe.source.committedAt,gameArchitecture:'x86_64',executableRelative:'bin/prosper-app',runtimeFiles:{vulkan:'managed'},files,notices};
 fs.writeFileSync(path.join(payload,'runtime.json'),json(manifest));
 const identity=record(payload,'runtime.json'),sourceFile=files.find(file=>file.path==='source.json');
 const declaration={id:'prosper',version,arch:'x64',launcherArchitectures:['arm64','x64'],minimumMacOS:manifest.minimumMacOS,directoryRelative:'prosper/'+version+'/x64',
  sourceRelative:'source.json',sourceSha256:sourceFile.sha256,manifestRelative:'runtime.json',manifestSha256:identity.sha256,files:[...files,identity],notices};
 validateDeclaration(declaration);fs.writeFileSync(path.join(output,'declaration.json'),json(declaration));
 return{payload,declaration:path.join(output,'declaration.json')};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{const options={};for(let i=2;i<process.argv.length;i+=2){const key={'--build-dir':'buildDirectory','--output':'output','--version':'version'}[process.argv[i]];if(!key||!process.argv[i+1])throw Error('Use --build-dir, --output and --version.');options[key]=process.argv[i+1];}console.log(json(await packageLocal(options)));}catch(error){console.error(error.message);process.exitCode=1;}}
