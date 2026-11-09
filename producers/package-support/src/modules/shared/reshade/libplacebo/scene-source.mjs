import {sourceRevision} from '../../../../../../../lib/pins.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {SOURCE,sceneDependencies,applySceneOverlay} from "./scene-overlay.mjs";
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run=(program,args,options={})=>execFileSync(program,args,{encoding:"utf8",stdio:"pipe",maxBuffer: Infinity,...options});
function archive(repository,dependency,output){
  fs.mkdirSync(output,{recursive:true});const content=run("git",["-C",repository,"archive",sourceRevision(dependency)],{encoding:null,env:{...process.env,GIT_NO_LAZY_FETCH:"1"}});run("tar",["-xf","-","-C",output],{input:content});
}
// Each architecture has an isolated source/build directory. No network or
// package installation occurs here; dependencies and tools are explicit inputs.
export function buildSceneLibrary({source,vulkanSource,inputs,dependencyHeaders=inputs,architecture,output,meson,ninja,python}){
  if(!["arm64","x86_64"].includes(architecture))throw new Error("Unsupported library architecture.");
  if(fs.existsSync(output))throw new Error("Choose an unused libplacebo source-build directory.");
  const tree=path.join(output,"source"),build=path.join(output,"build"),prefix=path.join(output,"install"),pc=path.join(output,"pkgconfig");
  const {vulkanHeaders,fastFloat}=sceneDependencies(source);
  archive(source,SOURCE,tree);archive(vulkanSource,vulkanHeaders,path.join(tree,"3rdparty/Vulkan-Headers"));
  const manifest=applySceneOverlay(tree);
  manifest.vulkanHeaders=vulkanHeaders;
  const fastFloatSource=path.join(source,"3rdparty/fast_float");
  archive(fastFloatSource,fastFloat,path.join(tree,"3rdparty/fast_float"));manifest.fastFloat=fastFloat;
  fs.mkdirSync(pc,{recursive:true});
  const shaderc=path.join(inputs,"shaderc/shaderc/2026.4"),lcms=path.join(inputs,"little-cms2/little-cms2/2.19.1");
  // These C headers are architecture independent. Binary-only Intel caches
  // reuse the declared common C interface, rather than acquiring new bottles.
  const headerInputs=[{name:"shaderc",version:"2026.4",root:path.join(dependencyHeaders,"shaderc/shaderc/2026.4/include"),files:["shaderc/shaderc.h","shaderc/env.h","shaderc/status.h","shaderc/visibility.h"]},{name:"lcms2",version:"2.19.1",root:path.join(dependencyHeaders,"little-cms2/little-cms2/2.19.1/include"),files:["lcms2.h","lcms2_plugin.h"]}];
  manifest.headerInputs=headerInputs.map(({root,files,...row})=>({...row,files:files.map(name=>({path:name}))}));
  for(const [index,name,version,root,library]of [[0,"shaderc","2026.4",shaderc,"shaderc_shared.1"],[1,"lcms2","2.19.1",lcms,"lcms2.2"]]){
    fs.writeFileSync(path.join(pc,name+".pc"),`Name: ${name}\nDescription: Explicit cached ${name} build input\nVersion: ${version}\nLibs: -L${path.join(root,"lib")} -l${library}\nCflags: -I${headerInputs[index].root}\n`);
  }
  const flags=["-Werror=unguarded-availability-new","-arch",architecture,"-mmacosx-version-min=13.0","-ffile-prefix-map="+tree+"=libplacebo","-ffile-prefix-map="+build+"=build"];
  const env={...process.env,PATH:path.dirname(meson)+path.delimiter+path.dirname(ninja)+path.delimiter+process.env.PATH,GIT_CEILING_DIRECTORIES:output,SDKROOT:process.env.SDKROOT||run("xcrun",["--sdk","macosx","--show-sdk-path"]).trim(),PKG_CONFIG_PATH:pc,PKG_CONFIG_LIBDIR:pc,CC:run("xcrun",["--find","clang"]).trim(),CXX:run("xcrun",["--find","clang++"]).trim(),CFLAGS:flags.join(" "),CXXFLAGS:flags.join(" "),LDFLAGS:["-arch",architecture,"-mmacosx-version-min=13.0"].join(" "),CPPFLAGS:"",CPATH:"",C_INCLUDE_PATH:"",CPLUS_INCLUDE_PATH:"",OBJC_INCLUDE_PATH:""};
  const machine=path.join(output,"machine.ini"),cpu=architecture==="arm64"?"aarch64":"x86_64";
  fs.writeFileSync(machine,`[binaries]\nc = '${env.CC}'\ncpp = '${env.CXX}'\nar = '/usr/bin/ar'\nstrip = '/usr/bin/strip'\npkg-config = '${run("/usr/bin/which",["pkg-config"]).trim()}'\n[host_machine]\nsystem = 'darwin'\ncpu_family = '${cpu}'\ncpu = '${cpu}'\nendian = 'little'\n[properties]\nneeds_exe_wrapper = false\n`);
  const args=["setup",build,tree,"--cross-file",machine,"--prefix",prefix,"--buildtype=release","--wrap-mode=nodownload","-Ddefault_library=shared","-Dvulkan=enabled","-Dvk-proc-addr=disabled","-Dopengl=disabled","-Dd3d11=disabled","-Dglslang=disabled","-Dshaderc=enabled","-Dlcms=enabled","-Dlibdovi=disabled","-Dunwind=disabled","-Dxxhash=disabled","-Ddemos=false","-Dtests=false","-Dbench=false","-Dfuzz=false"];
  const logged=(name,program,args)=>{try{fs.writeFileSync(path.join(output,name+".log"),run(program,args,{env}));}catch(error){fs.writeFileSync(path.join(output,name+".log"),String(error.stdout||"")+String(error.stderr||""));throw new Error("The libplacebo "+name+" failed; see "+path.join(output,name+".log"),{cause:error});}};
  logged("configure",meson,args);logged("compile",ninja,["-C",build,"-j2"]);logged("install",ninja,["-C",build,"install"]);
  const library=path.join(prefix,"lib/libplacebo.360.dylib");
  const result={...manifest,architecture,library,include:path.join(prefix,"include"),sha256:hash(library),buildTools:{meson:run(meson,["--version"]).trim(),ninja:run(ninja,["--version"]).trim()}};
  fs.writeFileSync(path.join(output,"source-build.json"),JSON.stringify(result,null,2)+"\n");return result;
}
