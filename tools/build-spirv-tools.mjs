// Build the original SPIR-V compiler library at the driver's macOS floor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
const root=path.resolve(import.meta.dirname,'..');
export const spirvToolsProfile=JSON.parse(fs.readFileSync(path.join(root,'producers/maclauncher/src/modules/shared/vulkan/native/spirv-tools-source.json')));
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const read=(command,args)=>execFileSync(command,args,{encoding:'utf8'}).trim();
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function buildSpirvTools({work,ninja,python,architecture='arm64',jobs=2}){
 if(architecture!=='arm64'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(ninja||'')||!path.isAbsolute(python||''))throw Error('SPIRV-Tools needs Apple Silicon, explicit tools and a new absolute work directory.');
 fs.mkdirSync(work,{recursive:true});
 const sources={};
 for(const row of spirvToolsProfile.sources){const archive=await buildInput(row.archive),directory=path.join(work,row.id);fs.mkdirSync(directory);run('tar',['-xf',archive,'--strip-components=1','-C',directory]);sources[row.id]=directory;}
 const build=path.join(work,'build'),prefix=path.join(work,'install'),floor=spirvToolsProfile.minimumMacOS;
 const flags=['-Werror=unguarded-availability-new','-ffile-prefix-map='+work+'=spirv-tools'];
 const env={...process.env,MACOSX_DEPLOYMENT_TARGET:floor,CFLAGS:'',CXXFLAGS:'',CPPFLAGS:'',LDFLAGS:'',CPATH:'',C_INCLUDE_PATH:'',CPLUS_INCLUDE_PATH:''};
 run('cmake',['-S',sources['spirv-tools'],'-B',build,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_DEPLOYMENT_TARGET='+floor,'-DCMAKE_OSX_SYSROOT='+read('xcrun',['--sdk','macosx','--show-sdk-path']),'-DCMAKE_MAKE_PROGRAM='+ninja,'-DPython3_EXECUTABLE='+python,
  '-DCMAKE_C_FLAGS='+flags.join(' '),'-DCMAKE_CXX_FLAGS='+flags.join(' '),'-DCMAKE_INSTALL_PREFIX='+prefix,'-DCMAKE_INSTALL_LIBDIR=lib','-DCMAKE_INSTALL_INCLUDEDIR=include','-DBUILD_SHARED_LIBS=ON','-DSPIRV_SKIP_TESTS=ON','-DSPIRV_SKIP_EXECUTABLES=ON','-DSPIRV_TOOLS_BUILD_STATIC=OFF','-DSPIRV-Headers_SOURCE_DIR='+sources['spirv-headers']],{env});
 run('cmake',['--build',build,'--target','SPIRV-Tools','SPIRV-Tools-opt','SPIRV-Tools-link','spirv-tools-pkg-config','-j',String(jobs)],{env});
 const lib=path.join(prefix,'lib'),pc=path.join(lib,'pkgconfig');fs.mkdirSync(pc,{recursive:true});
 for(const name of ['libSPIRV-Tools.dylib','libSPIRV-Tools-opt.dylib','libSPIRV-Tools-link.dylib'])fs.copyFileSync(path.join(build,'source',name==='libSPIRV-Tools.dylib'?'':name==='libSPIRV-Tools-opt.dylib'?'opt':'link',name),path.join(lib,name));
 fs.cpSync(path.join(sources['spirv-tools'],'include'),path.join(prefix,'include'),{recursive:true});
 fs.copyFileSync(path.join(build,'SPIRV-Tools.pc'),path.join(pc,'SPIRV-Tools.pc'));
 const notices=spirvToolsProfile.sources.map(row=>({file:path.join(sources[row.id],'LICENSE'),name:row.id,license:row.license,sourceUrl:row.repository}));
 const provenance={...spirvToolsProfile,architecture,librarySha256:hash(path.join(lib,'libSPIRV-Tools.dylib'))};
 fs.writeFileSync(path.join(work,'source-build.json'),JSON.stringify(provenance,null,2)+'\n');
 return {prefix,pkgConfigPath:pc,library:path.join(lib,'libSPIRV-Tools.dylib'),notices,provenance};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2);if(!['work','ninja','python'].includes(key)||!process.argv[i+1])throw Error('Use --work, --ninja and --python.');options[key]=path.resolve(process.argv[i+1]);}buildSpirvTools(options).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});}
