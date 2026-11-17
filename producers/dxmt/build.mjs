import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import inputs from './inputs.json' with {type:'json'};
import {applyWindowOverlay} from './window-overlay.mjs';
import {buildInput,llvmMingwInput} from '../../tools/build-input.mjs';
import {declaredSource,stageSource,findBuildTool,run} from '../../tools/build-source.mjs';
import {upstreamRevision} from '../../lib/projects.mjs';
import {appPath,appRequire} from '../../tools/app-source.mjs';
import {pythonBuildTools} from '../../tools/python-build-tools.mjs';
import {reproducibleEnvironment} from '../../lib/reproducible-build.mjs';
import {helperPackage} from '../../tools/helper-package.mjs';
import {addLicenses} from '../../lib/licenses.mjs';
import {applyStartupOverlay} from '../package-support/src/modules/crossover/temporal/dxmt/startup-overlay.mjs';
import {applyReferenceOwnershipOverlay} from '../package-support/src/modules/crossover/temporal/dxmt/reference-ownership-overlay.mjs';
import {applyRingCapacityOverlay} from '../package-support/src/modules/crossover/temporal/dxmt/ring-capacity-overlay.mjs';
import {applyCompilerShutdownOverlay} from '../package-support/src/modules/crossover/temporal/dxmt/compiler-shutdown-overlay.mjs';
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',...options}).trim();
const quote=value=>JSON.stringify(value);
const owned=()=>appPath('src/modules/crossover/temporal/dxmt');
export function sourceVersion(revision){return 'v0.80-244-g'+revision.slice(0,7);}
export function configureVersion(source,revision){
 const file=path.join(source,'meson.build'),before=fs.readFileSync(file,'utf8');
 const expression=/dxmt_version = vcs_tag\([\s\S]*?\n\)/;
 if((before.match(new RegExp(expression.source,'g'))||[]).length!==1)throw Error('DXMT version source anchor changed.');
 fs.writeFileSync(file,before.replace(expression,"dxmt_version = configure_file(input: 'version.h.in', output: 'version.h', configuration: {'VCS_TAG': '"+sourceVersion(revision)+"'})"));
}
async function extract(input,destination,{members,strip=1}={}){
 const archive=await buildInput(input);
 fs.mkdirSync(destination,{recursive:true});
 run('/usr/bin/tar',['-xf',archive,'--no-same-owner','--strip-components',String(strip),'-C',destination,...(members||[])]);
 return archive;
}
export async function prepare({arch,work}){
 if(arch!=='arm64')throw Error('This DXMT build produces the arm64 renderer and ARM64EC Windows libraries.');
 if(!path.isAbsolute(work||'')||fs.existsSync(path.join(work,'source')))throw Error('Use a new absolute DXMT work directory.');
 fs.mkdirSync(work,{recursive:true});
 const source=path.join(work,'source'),sourceRoot=declaredSource('dxmt','dxmt'),revision=upstreamRevision('dxmt','dxmt');
 const sourceFacts=await stageSource(sourceRoot,revision,source);
 for(const file of ['include/native/directx/d3d11.h','external/nvapi/nvapi.h'])if(!fs.existsSync(path.join(source,file)))throw Error('A declared DXMT source dependency is missing: '+file);
 const native=path.join(work,'llvm-source'),sdk=path.join(work,'wine-sdk'),compiler=path.join(work,'llvm-mingw');
 await extract(inputs.llvm,native);
 const cmake=path.join(work,'cmake');
 await extract(inputs.llvmCmake,cmake);
 const sdkArchive=await buildInput(inputs.wineSdk);
 const sdkMembers=read('/usr/bin/tar',['-tf',sdkArchive]).split('\n').filter(name=>
  name.startsWith('./wine-11.2/include/')||
  /^\.\/wine-11\.2\/lib\/wine\/aarch64-windows\/[^/]+\.a$/.test(name)||
  /^\.\/wine-11\.2\/lib\/wine\/aarch64-unix\/(?:winemac|ntdll)\.so$/.test(name)||
  /^\.\/wine-11\.2\/bin\/(?:winebuild|winegcc)$/.test(name)||
  /^\.\/wine-11\.2\/(?:COPYING[^/]*|LICENSE[^/]*|AUTHORS)$/.test(name));
 if(!sdkMembers.some(name=>name.endsWith('/bin/winebuild'))||!sdkMembers.some(name=>name.endsWith('/aarch64-unix/winemac.so')))throw Error('The declared Wine SDK is incomplete.');
 await extract(inputs.wineSdk,sdk,{members:sdkMembers,strip:2});
 await extract(llvmMingwInput(),compiler);
 const tools=await pythonBuildTools(path.join(work,'build-tools'),'sdk27');
 const shared=appPath('src/modules/shared/reshade/temporal');
 for(const file of ['camera.h','frame.h','scene-aovs.h'])fs.copyFileSync(path.join(shared,file),path.join(source,'include',file));
 fs.copyFileSync(appPath('src/modules/shared/reshade/native/image-color.h'),path.join(source,'include/image-color.h'));
 for(const file of ['camera-transport.hpp','streamline-transport.hpp','streamline-native.h','streamline-snapshot.hpp'])fs.copyFileSync(path.join(owned(),file),path.join(source,'include',file));
 applyStartupOverlay(source);applyReferenceOwnershipOverlay(source);applyRingCapacityOverlay(source);applyCompilerShutdownOverlay(source);
 const {applyCameraOverlay}=await import(path.join(owned(),'patch.mjs'));
 const {applyTemporalD3D12}=await import(path.join(owned(),'d3d12-overlay.mjs'));
 applyCameraOverlay(source);applyTemporalD3D12(source);
 const windowAbi=applyWindowOverlay(source);configureVersion(source,revision);
 const result={source,sourceRoot,revision,sourceFacts,windowAbi,llvmSource:native,sdk,compiler,tools,work};
 write(path.join(work,'source-inputs.json'),{revision,sourceFacts,archives:[inputs.llvm,inputs.llvmCmake,inputs.wineSdk,llvmMingwInput()]});
 return result;
}
export function crossFile(prepared){
 const bin=path.join(prepared.compiler,'bin'),prefix='arm64ec-w64-mingw32-';
 const commands={c:'clang',cpp:'clang++',ar:'ar',strip:'strip',windres:'windres'};
 for(const executable of Object.values(commands))if(!fs.existsSync(path.join(bin,prefix+executable)))throw Error('The declared compiler lacks ARM64EC '+executable+'.');
 return '[binaries]\n'+Object.entries(commands).map(([key,value])=>key+' = '+quote(path.join(bin,prefix+value))).join('\n')+
  "\n[properties]\nneeds_exe_wrapper = true\n[built-in options]\nc_args = ['-marm64x']\ncpp_args = ['-marm64x']\nc_link_args = ['-marm64x']\ncpp_link_args = ['-marm64x']\n[host_machine]\nsystem = 'windows'\ncpu_family = 'aarch64'\ncpu = 'aarch64'\nendian = 'little'\n";
}
export async function compile({work,prepared}){
 const cmake=findBuildTool('cmake'),ninja=path.join(prepared.tools.bin,'ninja'),meson=path.join(prepared.tools.bin,'meson');
 const sdk=read('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path']),clang=read('/usr/bin/xcrun',['--find','clang']),clangxx=read('/usr/bin/xcrun',['--find','clang++']);
 for(const tool of ['metal','metallib'])if(!fs.statSync(read('/usr/bin/xcrun',['--sdk','macosx','--find',tool])).isFile())throw Error('The selected Xcode lacks '+tool+'.');
 const maps=[...new Set([work,fs.realpathSync(work)])].flatMap(from=>['file','debug','macro'].map(kind=>'-f'+kind+'-prefix-map='+from+'=source/dxmt'));
 const flags=['-O2','-g0',...maps].join(' ');
 const env=reproducibleEnvironment({...process.env,SDKROOT:sdk,MACOSX_DEPLOYMENT_TARGET:inputs.minimumMacOS,PATH:path.join(prepared.compiler,'bin')+path.delimiter+process.env.PATH});
 const llvmBuild=path.join(work,'llvm-build'),llvm=path.join(work,'llvm');
 run(cmake,['-S',prepared.llvmSource,'-B',llvmBuild,'-G','Ninja','-DCMAKE_MAKE_PROGRAM='+ninja,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX='+llvm,
  '-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_DEPLOYMENT_TARGET='+inputs.minimumMacOS,'-DCMAKE_C_COMPILER='+clang,'-DCMAKE_CXX_COMPILER='+clangxx,
  '-DCMAKE_C_FLAGS='+flags,'-DCMAKE_CXX_FLAGS='+flags,'-DLLVM_TARGETS_TO_BUILD=','-DLLVM_APPEND_VC_REV=OFF','-DLLVM_BUILD_TOOLS=OFF','-DLLVM_BUILD_UTILS=OFF',
  '-DLLVM_INCLUDE_TESTS=OFF','-DLLVM_INCLUDE_BENCHMARKS=OFF','-DLLVM_INCLUDE_EXAMPLES=OFF','-DLLVM_ENABLE_ZSTD=OFF','-DLLVM_ENABLE_LIBXML2=OFF','-DLLVM_ENABLE_TERMINFO=OFF','-DCMAKE_POLICY_VERSION_MINIMUM=3.5'],{env});
 run(cmake,['--build',llvmBuild,'--target','install','--parallel','6'],{env});
 const cross=path.join(work,'arm64ec.ini'),native=path.join(work,'native.ini'),build=path.join(work,'renderer'),staged=path.join(work,'installed');
 fs.writeFileSync(cross,crossFile(prepared));
 const nativeArgs=['-arch','arm64','-mmacosx-version-min='+inputs.minimumMacOS,'-O2','-g0',...maps];
 fs.writeFileSync(native,'[binaries]\nc = '+quote(clang)+'\ncpp = '+quote(clangxx)+'\n[built-in options]\nc_args = '+JSON.stringify(nativeArgs)+'\ncpp_args = '+JSON.stringify(nativeArgs)+'\nc_link_args = '+JSON.stringify(['-arch','arm64'])+'\ncpp_link_args = '+JSON.stringify(['-arch','arm64'])+'\n');
 run(meson,['setup',build,prepared.source,'--cross-file',cross,'--native-file',native,'--prefix','/','--buildtype','release',
  '-Dnative_llvm_path='+llvm,'-Dwine_install_path='+prepared.sdk,'-Dwine_builtin_dll=true','-Denable_tests=false','-Denable_nvngx=true','-Denable_d3d12=true'],{env:{...env,CFLAGS:maps.join(' '),CXXFLAGS:maps.join(' ')}});
 run(meson,['compile','-C',build,'-j','6'],{env});
 run(meson,['install','-C',build,'--destdir',staged,'--no-rebuild'],{env});
 const result={...prepared,staged};write(path.join(work,'compiled.json'),result);return result;
}
export async function inspectBuiltPayload(payload){
 const Binary=appRequire('src/core/binary-arch'),{readPeExports}=appRequire('src/modules/shared/runtime/pe-exports');
 const {readMachOLoadCommands}=appRequire('src/modules/shared/runtime/macho-load-commands');
 const {inspectMachOExports}=appRequire('src/modules/shared/runtime/macho-exports');
 const native=path.join(payload,'wine/aarch64-unix/winemetal.so'),facts=Binary.inspectBinary(native);
 if(facts.format!=='macho'||!facts.architectures.includes('arm64'))throw Error('DXMT did not produce its native arm64 renderer.');
 const image=readMachOLoadCommands(native,{architecture:'arm64',imports:true}).slices[0];
 if(image.fileType!==6||image.installName?.path!=='@rpath/winemetal.so')throw Error('DXMT native library identity is invalid.');
 const permitted=new Set(['@rpath/winemac.so','@rpath/ntdll.so']);
 for(const dependency of image.dependencies)if(!/^\/(?:usr\/lib|System\/Library)\//.test(dependency.path)&&!permitted.has(dependency.path))throw Error('DXMT has an undeclared native dependency: '+dependency.path);
 if(image.runPaths.some(value=>!value.startsWith('@loader_path')&&!value.startsWith('@executable_path')))throw Error('DXMT retains a build search path.');
 const names=await inspectMachOExports(native,{arch:'arm64'});
 for(const name of ['__wine_unix_call_funcs','__wine_unix_call_wow64_funcs'])if(!names.includes(name))throw Error('DXMT is missing its Unix call table: '+name);
 const required={'d3d11.dll':'D3D11CreateDevice','dxgi.dll':'CreateDXGIFactory1','winemetal.dll':'UpdateMetalViewPlacement'};
 const windows=[];
 for(const file of fs.readdirSync(path.join(payload,'wine/aarch64-windows')).filter(file=>file.endsWith('.dll'))){
  const absolute=path.join(payload,'wine/aarch64-windows',file),binary=Binary.inspectBinary(absolute),pe=readPeExports(absolute);
  const cpus=binary.hybrid?.codeArchitectures||[binary.machine];
  if(binary.format!=='pe'||!cpus.some(cpu=>['arm64ec','arm64x'].includes(cpu))||!pe?.isDll)throw Error('DXMT produced an incompatible Windows library: '+file);
  if(required[file]&&!pe.exports.get(required[file])?.executable)throw Error('DXMT is missing its executable API: '+required[file]);
  windows.push({file,machine:binary.machine,machineCode:binary.machineCode,codeArchitectures:cpus});
 }
 if(Object.keys(required).some(file=>!windows.some(row=>row.file===file)))throw Error('DXMT Windows library closure is incomplete.');
 return {native:image,windows};
}
export async function assemble({project='dxmt',version,arch,output,work,compiled}){
 compiled ||= JSON.parse(fs.readFileSync(path.join(work,'compiled.json')));
 if(arch!=='arm64'||fs.existsSync(output))throw Error('DXMT needs a new immutable arm64 output.');
 const payload=path.join(output,'payload'),wine=path.join(payload,'wine');fs.mkdirSync(wine,{recursive:true});
 for(const directory of ['aarch64-windows','aarch64-unix']){
  const source=path.join(compiled.staged,directory);if(!fs.existsSync(source))throw Error('DXMT did not produce '+directory+'.');
  fs.mkdirSync(path.join(wine,directory));
  for(const file of fs.readdirSync(source))if(directory.endsWith('-windows')?file.endsWith('.dll'):file==='winemetal.so')fs.copyFileSync(path.join(source,file),path.join(wine,directory,file));
 }
 for(const file of ['aarch64-windows/d3d11.dll','aarch64-windows/dxgi.dll','aarch64-windows/winemetal.dll','aarch64-unix/winemetal.so'])if(!fs.existsSync(path.join(wine,file)))throw Error('DXMT runtime closure is missing '+file+'.');
 fs.writeFileSync(path.join(wine,'VERSION'),'DXMT '+sourceVersion(compiled.revision)+'\n');
 await inspectBuiltPayload(payload);
 run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',path.join(wine,'aarch64-unix/winemetal.so')]);
 addLicenses(payload,'DXMT',compiled.source);
 addLicenses(payload,'Mullion window presentation',import.meta.dirname);
 addLicenses(payload,'LLVM',compiled.llvmSource);
 addLicenses(payload,'Wine build SDK',compiled.sdk);
 addLicenses(payload,'DirectX headers',path.join(compiled.source,'include/native/directx'));
 return helperPackage({id:project,version,arch,output,minimumMacOS:inputs.minimumMacOS,sourceSha256:sha(path.join(import.meta.dirname,'build.mjs')),manifestRelative:'manifest.json',
  record:{engine:'dxmt',platform:'darwin',executableRelative:'wine/aarch64-unix/winemetal.so',upstreamRevision:compiled.revision,dependencies:[],
   windowsArchitecture:'arm64ec',nativeArchitecture:'arm64',unixCallCount:compiled.windowAbi.tableCount,wineLinkLibraries:['winemac.so','ntdll.so']}});
}
