// Build the original Zstandard runtime at the declared macOS floor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
const root=path.resolve(import.meta.dirname,'..');
export const zstdProfile=JSON.parse(fs.readFileSync(path.join(root,'producers/maclauncher/src/modules/shared/vulkan/native/zstd-source.json')));
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const read=(command,args)=>execFileSync(command,args,{encoding:'utf8'}).trim();
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function buildZstd({work,architecture='arm64',jobs=2,ninja='ninja'}){
 if(!['arm64','x64'].includes(architecture)||!path.isAbsolute(work||'')||fs.existsSync(work)||!Number.isSafeInteger(jobs)||jobs<1||jobs>4)throw Error('Zstandard needs a declared CPU, one to four jobs and a new absolute work directory.');
 fs.mkdirSync(work,{recursive:true});const archive=await buildInput(zstdProfile.archive),source=path.join(work,'source'),build=path.join(work,'build'),prefix=path.join(work,'install'),floor=zstdProfile.minimumMacOS;
 fs.mkdirSync(source);run('tar',['-xf',archive,'--strip-components=1','-C',source]);
 const sdk=process.env.SDKROOT||read('xcrun',['--sdk','macosx','--show-sdk-path']),flags=['-ffile-prefix-map='+work+'=zstd-build','-fdebug-prefix-map='+work+'=zstd-build','-Werror=unguarded-availability-new'];
 const env={...process.env,MACOSX_DEPLOYMENT_TARGET:floor,CFLAGS:'',CXXFLAGS:'',CPPFLAGS:'',LDFLAGS:'',CPATH:'',C_INCLUDE_PATH:'',CPLUS_INCLUDE_PATH:''};
 run('cmake',['-S',path.join(source,'build/cmake'),'-B',build,'-G','Ninja','-DCMAKE_MAKE_PROGRAM='+ninja,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES='+ (architecture==='x64'?'x86_64':architecture),'-DCMAKE_OSX_DEPLOYMENT_TARGET='+floor,'-DCMAKE_OSX_SYSROOT='+sdk,'-DCMAKE_C_FLAGS='+flags.join(' '),'-DCMAKE_INSTALL_PREFIX='+prefix,'-DCMAKE_INSTALL_LIBDIR=lib','-DCMAKE_INSTALL_INCLUDEDIR=include','-DCMAKE_INSTALL_NAME_DIR='+path.join(prefix,'lib'),'-DZSTD_BUILD_SHARED=ON','-DZSTD_BUILD_STATIC=OFF','-DZSTD_BUILD_PROGRAMS=OFF','-DZSTD_BUILD_TESTS=OFF'],{env});
 run('cmake',['--build',build,'--target','install','--parallel',String(jobs)],{env});
 const library=path.join(prefix,'lib/libzstd.'+zstdProfile.version+'.dylib'),notices=['LICENSE','COPYING'].map(name=>({file:path.join(source,name),name:'Zstandard '+name,license:'BSD-3-Clause OR GPL-2.0-only',sourceUrl:zstdProfile.repository}));
 const provenance={...zstdProfile,architecture,librarySha256:hash(library)};fs.writeFileSync(path.join(work,'source-build.json'),JSON.stringify(provenance,null,2)+'\n');
 return {prefix,pkgConfigPath:path.join(prefix,'lib/pkgconfig'),library,notices,provenance};
}
