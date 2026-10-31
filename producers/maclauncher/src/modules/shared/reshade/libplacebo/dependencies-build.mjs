// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildInput} from '../../../../../../../tools/build-input.mjs';
export const profile=JSON.parse(fs.readFileSync(new URL('./dependencies.json',import.meta.url)));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
/** Original compiler and color-management libraries, with explicit sources and OS target. */
export async function buildDependencies({work,architecture,meson,ninja,python}) {
 if(!['arm64','x86_64'].includes(architecture)||!path.isAbsolute(work))throw Error('Choose a native CPU and absolute dependency work directory.');
 const source=path.join(work,'source'),build=path.join(work,'build'),prefix=path.join(work,'install');
 fs.mkdirSync(source,{recursive:true});fs.mkdirSync(build,{recursive:true});fs.mkdirSync(prefix,{recursive:true});
 for(const row of profile.sources){const target=path.join(source,row.id);if(fs.existsSync(target))continue;
  const archive=await buildInput(row);fs.mkdirSync(target);run('tar',['-xf',archive,'--strip-components=1','-C',target]);}
 const sdk=execFileSync('xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();
 const flags=['-arch',architecture,'-mmacosx-version-min='+profile.minimumMacOS,'-Werror=unguarded-availability-new','-ffile-prefix-map='+work+'=dependencies'];
 const env={...process.env,MACOSX_DEPLOYMENT_TARGET:profile.minimumMacOS,SDKROOT:sdk,
  CC:execFileSync('xcrun',['--find','clang'],{encoding:'utf8'}).trim(),CXX:execFileSync('xcrun',['--find','clang++'],{encoding:'utf8'}).trim(),
  CFLAGS:flags.join(' '),CXXFLAGS:flags.join(' '),CPPFLAGS:'',LDFLAGS:flags.join(' '),CPATH:'',C_INCLUDE_PATH:'',CPLUS_INCLUDE_PATH:'',OBJC_INCLUDE_PATH:'',
  PKG_CONFIG_PATH:'',PKG_CONFIG_LIBDIR:path.join(work,'no-system-pkgconfig'),PATH:[path.dirname(meson),path.dirname(ninja),...(python?[path.dirname(python)]:[]),process.env.PATH].join(path.delimiter)};
 const shaderBuild=path.join(build,'shaderc'),wrapper=path.join(work,'cmake');fs.mkdirSync(wrapper,{recursive:true});fs.copyFileSync(new URL('./dependencies-CMakeLists.txt',import.meta.url),path.join(wrapper,'CMakeLists.txt'));
 run('cmake',['-S',wrapper,'-B',shaderBuild,'-G','Ninja',
  '-DSHADERC_SOURCE='+path.join(source,'shaderc'),'-DGLSLANG_SOURCE='+path.join(source,'glslang'),'-DSPIRV_TOOLS_SOURCE='+path.join(source,'spirv-tools'),'-DSPIRV_HEADERS_SOURCE='+path.join(source,'spirv-headers'),
  '-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES='+architecture,'-DCMAKE_OSX_DEPLOYMENT_TARGET='+profile.minimumMacOS,'-DCMAKE_OSX_SYSROOT='+sdk,
  '-DCMAKE_MAKE_PROGRAM='+ninja,...(python?['-DPython_EXECUTABLE='+python,'-DPython3_EXECUTABLE='+python]:[])],{env});
 run('cmake',['--build',shaderBuild,'--target','shaderc_shared','-j','4'],{env});
 const shaderRoot=path.join(prefix,'shaderc/shaderc/'+profile.shadercVersion),shaderLib=path.join(shaderRoot,'lib');fs.mkdirSync(shaderLib,{recursive:true});
 fs.copyFileSync(path.join(shaderBuild,'upstream/libshaderc/libshaderc_shared.1.dylib'),path.join(shaderLib,'libshaderc_shared.1.dylib'));
 fs.cpSync(path.join(source,'shaderc/libshaderc/include'),path.join(shaderRoot,'include'),{recursive:true});fs.copyFileSync(path.join(source,'shaderc/LICENSE'),path.join(shaderRoot,'LICENSE'));
 const lcmsBuild=path.join(build,'lcms2'),lcmsRoot=path.join(prefix,'little-cms2/little-cms2/'+profile.lcmsVersion);
 if(!fs.existsSync(path.join(lcmsBuild,'build.ninja')))run(meson,['setup',lcmsBuild,path.join(source,'lcms2'),'--prefix',lcmsRoot,'--libdir=lib','--buildtype=release','--wrap-mode=nodownload','-Ddefault_library=shared','-Djpeg=disabled','-Dtiff=disabled','-Dutils=false','-Dtests=disabled'],{env});
 run(ninja,['-C',lcmsBuild,'-j4'],{env});run(ninja,['-C',lcmsBuild,'install'],{env});
 const lcmsLib=path.join(lcmsRoot,'lib'),actual=fs.readdirSync(lcmsLib).find(name=>/^liblcms2\..*\.dylib$/.test(name)&&fs.lstatSync(path.join(lcmsLib,name)).isFile());
 if(!actual)throw Error('Little CMS did not produce a shared library.');if(actual!=='liblcms2.2.dylib')fs.copyFileSync(path.join(lcmsLib,actual),path.join(lcmsLib,'liblcms2.2.dylib'));
 fs.copyFileSync(path.join(source,'lcms2/LICENSE'),path.join(lcmsRoot,'LICENSE'));
 const notices=profile.sources.map(row=>{const root=path.join(source,row.id),name=fs.existsSync(path.join(root,'LICENSE'))?'LICENSE':fs.existsSync(path.join(root,'COPYING'))?'COPYING':'LICENSE.txt';return {name:row.id+'.LICENSE',file:path.join(root,name),sha256:hash(path.join(root,name))};});
 return {inputs:prefix,source:profile.sources,notices,shadercVersion:profile.shadercVersion,lcmsVersion:profile.lcmsVersion};
}
