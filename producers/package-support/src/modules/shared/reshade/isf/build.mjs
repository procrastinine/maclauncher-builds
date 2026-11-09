import {appPath,appRequire} from '../../../../../../../tools/app-source.mjs';
import {addLicenses} from '../../../../../../../lib/licenses.mjs';
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {isolateCompiler} from './isolate-compiler.mjs';
import {buildCompilers} from "./build-compilers.mjs";
const {SCENE_SHADER_INPUTS}=appRequire('src/modules/shared/effects/operation-contracts.mjs');
const owned=import.meta.dirname,workspace=path.resolve(owned,"../../../../.."),source=JSON.parse(fs.readFileSync(path.join(owned,"source.json")));
const module="src/modules/shared/reshade/isf",app=appPath(module),nativeRoot=appPath("src/modules/shared/reshade/native");
const output=path.resolve(process.argv[2]||""),options={};
for(let i=3;i<process.argv.length;i+=2){const key=process.argv[i];if(!["--payload","--source","--arch","--phase","--glslang","--spirv-cross","--spirv-tools","--spirv-headers"].includes(key)||!process.argv[i+1]||Object.hasOwn(options,key))throw Error("Choose an ISF build directory, --payload, --source and --arch.");options[key]=process.argv[i+1];}
const arch=options["--arch"]||"universal",architectures=arch==="universal"?["arm64","x86_64"]:[arch==="x64"?"x86_64":arch];
if(!process.argv[2]||!["universal","x64","arm64"].includes(arch))throw Error("Choose an ISF build directory and a package architecture.");
const upstream=options["--source"]?path.resolve(options["--source"]):path.join(workspace,source.sources[0].path);
const run=(cmd,args)=>execFileSync(cmd,args,{stdio:"inherit"});
const write=(file,bytes)=>{bytes=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);if(!fs.existsSync(file)||!fs.readFileSync(file).equals(bytes))fs.writeFileSync(file,bytes);};
// --phase compile adapts the sources and compiles the provider; --phase assemble writes the licenses and
// provider.json from the compiled payload, the compiler's dependency file and the declared inputs alone.
// Without --phase both run.
const phase=options["--phase"]||null;
const input=path.join(output,"input"),payload=options["--payload"]?path.resolve(options["--payload"]):path.join(output,"payload");
const roots={ISFMSLKit:path.join(upstream,"ISFMSLKit"),VVMetalKit:path.join(upstream,"submodules/VVMetalKit/VVMetalKit"),PINCache:path.join(upstream,"submodules/PINCache/Source"),PINOperation:path.join(upstream,"submodules/PINCache/Carthage/Checkouts/PINOperation/Source"),generator:path.join(upstream,"submodules/ISFGLSLGenerator/libISFGLSLGenerator")};
/** The declared upstream files, adapted into the build input directory when compiling. */
function scanInputs(emit){
const names=new Set(),inputs=[];
for(const [name,root]of Object.entries(roots)){
  if(emit)fs.mkdirSync(path.join(input,name),{recursive:true});
  const directories=name==="generator"?[path.join(root,"include"),path.join(root,"src")]:[root];
  for(const directory of directories)for(const filename of fs.readdirSync(directory).sort()){
    const file=path.join(directory,filename);if(!fs.lstatSync(file).isFile()||! /\.(?:h|hpp|m|mm|cpp|metal)$/.test(filename))continue;
    let bytes=fs.readFileSync(file),text=bytes.toString("utf8");for(const match of text.matchAll(/@(?:interface|protocol)\s+([A-Za-z_]\w*)/g))if(!/^(?:NS|CI|MTL|CG)/.test(match[1]))names.add(match[1]);
    for(const match of text.matchAll(/\b(?:isVV[A-Za-z_]\w*|isfMD5String)\b/g))names.add(match[0]);
    // Library shaders use their own resource bundle rather than the game's.
    if(name==="VVMetalKit"&&/\.(?:m|mm)$/.test(filename))text=text.replace(/\[(?:self\.device|device|n|inDevice) newDefaultLibraryWithBundle:myBundle error:&nsErr\]/g,"MCLISFDefaultLibrary(self.device)");
    if(name==="VVMetalKit"&&filename==="VVMTLPool.m")text=text.replace(/\[_device newTextureWithDescriptor:texDesc\]/g,"MCLISFNewTexture(_device,texDesc)");
    if(emit)write(path.join(input,name,filename),text);inputs.push({path:path.relative(upstream,file),sha256:crypto.createHash("sha256").update(bytes).digest("hex")});
  }
}
return {names,inputs};
}
const compilerSources=Object.fromEntries(source.compilerSources.map(entry=>[entry.id,options["--"+entry.id]&&path.resolve(options["--"+entry.id])]));
/** Adapt the sources and compile the provider into the payload. */
function compile(){
if(fs.existsSync(path.join(payload,"provider.json")))throw Error("Choose a new ISF payload directory; the build cache can be reused.");
fs.mkdirSync(input,{recursive:true});fs.mkdirSync(payload,{recursive:true});
const {names}=scanInputs(true);
const prefix=["#include <stdint.h>","#ifdef __OBJC__","#import <Metal/Metal.h>","#ifdef __cplusplus","extern \"C\" {","#endif","id<MTLLibrary> MCLISFDefaultLibrary(id<MTLDevice>);","id<MTLTexture> MCLISFNewTexture(id<MTLDevice>,MTLTextureDescriptor*);","#ifdef __cplusplus","}","#endif","#endif",...[...names].sort().map(name=>`#define ${name} MCLGraphics_${name}`)].join("\n")+"\n";write(path.join(input,"prefix.h"),prefix);
const compilers=buildCompilers({work:output,architectures,sources:compilerSources});
for(const entry of compilers){
  const library=path.join(input,path.basename(entry.library));write(library,fs.readFileSync(entry.library));
  isolateCompiler(library);
  write(path.join(input,path.basename(entry.header)),fs.readFileSync(entry.header));
}
run("cmake",["-S",app,"-B",path.join(output,"cmake"),"-DISF_INPUT="+input,"-DMACFX_INPUT="+nativeRoot,"-DCMAKE_BUILD_TYPE=Release","-DCMAKE_OSX_ARCHITECTURES="+architectures.join(";")]);
run("cmake",["--build",path.join(output,"cmake"),"--parallel","2"]);
fs.copyFileSync(path.join(output,"cmake/libmacfx-isf.dylib"),path.join(payload,source.library));
for(const file of source.compilerLibraries){const filename=path.basename(file);fs.copyFileSync(path.join(input,filename),path.join(payload,filename));}
const shaderRoot=roots.VVMetalKit,air=[];
for(const name of ["CopierMTLScene","SwizzleMTLScene"]){const file=path.join(output,name+".air");run("xcrun",["-sdk","macosx","metal","-std=metal3.0","-mmacosx-version-min=13.0","-I",shaderRoot,"-I",input,"-c",path.join(shaderRoot,name+".metal"),"-o",file]);air.push(file);}
run("xcrun",["-sdk","macosx","metallib",...air,"-o",path.join(payload,"default.metallib")]);
for(const name of [source.library,...source.compilerLibraries.map(file=>path.basename(file))])run("codesign",["--force","--sign","-",path.join(payload,name)]);
}
/** Write the licenses and provider.json from the compiled payload and the declared inputs. */
function assemble(){
for(const entry of source.compilerSources)addLicenses(payload,entry.id,compilerSources[entry.id]);
addLicenses(payload,'ISF',upstream);
addLicenses(payload,'VVMetalKit',path.join(upstream,'submodules/VVMetalKit'));
for(const [name,root]of Object.entries(roots))addLicenses(payload,name,root);
const {inputs}=scanInputs(false);
const files=fs.readdirSync(payload,{recursive:true}).filter(name=>name!=="provider.json"&&fs.statSync(path.join(payload,name)).isFile()).sort().map(name=>{const bytes=fs.readFileSync(path.join(payload,name));return {path:name,size:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")};});
const dependencyText=fs.readFileSync(path.join(output,"cmake/CMakeFiles/macfx-isf.dir/provider.mm.o.d"),"utf8").replace(/\\\r?\n/g," ");
const dependencies=[...dependencyText.matchAll(/(?:\\.|[^\s])+/g)].map(match=>match[0].replace(/\\(.)/g,"$1")).filter(file=>file.startsWith(nativeRoot+path.sep)&&/\.(?:h|hpp)$/.test(file));
const headerInputs=Object.fromEntries([...new Set(dependencies)].sort().map(file=>[path.relative(nativeRoot,file),crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
fs.writeFileSync(path.join(payload,"provider.json"),JSON.stringify({...source,architectures,sceneInputsAPI:1,sceneInputRoles:SCENE_SHADER_INPUTS.filter(role=>!["viewMatrix","projectionMatrix"].includes(role)),inputs,headerInputs,files},null,2)+"\n");console.log(JSON.stringify({payload,files:files.length}));
}
if(phase!=="assemble")compile();
if(phase!=="compile")assemble();
