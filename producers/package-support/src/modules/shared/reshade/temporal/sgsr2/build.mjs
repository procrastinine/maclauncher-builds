#!/usr/bin/env node
import {sourceRevision} from '../../../../../../../../lib/pins.mjs';
const revision=sourceRevision({gitlink:'producers/package-support/src/external/sgsr2'});
import {addLicenses} from '../../../../../../../../lib/licenses.mjs';
import {appPath} from '../../../../../../../../tools/app-source.mjs';
// Offline GLSL -> SPIR-V -> Metal translation of Qualcomm's two-pass SGSR2.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const app=appPath('src/modules/shared/reshade/temporal/sgsr2'),spec=JSON.parse(fs.readFileSync(path.join(app,'source.json'),'utf8'));
const options={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(key==='--phase'&&!options[key]&&['compile','assemble'].includes(process.argv[i+1])){options[key]=process.argv[i+1];continue;}if(!['--source','--tools','--shaderc-library','--shaderc-headers','--output'].includes(key)||!process.argv[i+1]||options[key])throw new Error('Expected unique named build input paths.');options[key]=path.resolve(process.argv[i+1]);}
for(const key of ['--source','--output','--tools','--shaderc-library','--shaderc-headers'])if(!options[key])throw new Error('Missing '+key);
const run=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',maxBuffer: Infinity});
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source=options['--source'],out=options['--output'],tools=options['--tools'];
const phase=options['--phase'];
/** Translate the shaders and build the universal provider library. */
function compile(){
 if(fs.existsSync(out))throw new Error('Choose a new immutable output directory.');
 fs.mkdirSync(path.join(out,'sgsr2'),{recursive:true});
 const compiler=path.join(out,'shaderc-offline');
 const compilerArchitectures=run('lipo',['-archs',options['--shaderc-library']]).trim().split(/\s+/),hostCPU=process.arch==='x64'?'x86_64':process.arch;
 const compilerCPU=compilerArchitectures.includes(hostCPU)?hostCPU:compilerArchitectures.length===1?compilerArchitectures[0]:null;
 if(!['arm64','x86_64'].includes(compilerCPU))throw new Error('Shader compiler library has no supported build-host CPU.');
 run('xcrun',['clang++','-std=c++17','-O2','-arch',compilerCPU,'-I',options['--shaderc-headers'],path.join(app,'../../shaderc-offline.cpp'),'-o',compiler]);
 for(const filename of Object.keys(spec.shaders)){
   const original=path.join(source,'sgsr/v2/include/glsl_2_pass_cs',filename);
   let text=fs.readFileSync(original,'utf8');
   // GLSL's image/sampler namespaces become unique Vulkan descriptor bindings.
   text=text.replace(/layout\(binding = (\d+)\)( uniform highp [u]?sampler2D)/g,(_all,slot,decl)=>`layout(binding = ${32+Number(slot)})${decl}`)
     .replace(/layout\(binding = (\d+), (rgba16f|r32ui)\)/g,(_all,slot,format)=>`layout(binding = ${64+Number(slot)}, ${format})`);
   const convert=filename.includes('convert');
   text=text.replace('void main()\n{',`void main()\n{\n    if(any(greaterThanEqual(gl_GlobalInvocationID.xy, params.${convert?'renderSize':'displaySize'}))) return;`);
   if(convert){
     const begin=text.indexOf('    vec2 motion;'),end=text.indexOf('    ////////////compute luma',begin);
     if(begin<0||end<0)throw new Error('SGSR motion input boundary changed.');
     // The common contract supplies every pixel's real motion. Do not interpret
     // signed motion as Unreal's packed encoding or invent projection matrices.
     text=text.slice(0,begin)+'    vec2 motion = EncodedVelocity.xy;\n\n'+text.slice(end);
   }else{
     const from='texelFetch(YCoCgColor, InputPosBtmRight, 0)';
     if(!text.includes(from))throw new Error('SGSR edge load changed.');
     text=text.replace(from,'texelFetch(YCoCgColor, clamp(InputPosBtmRight, ivec2(0), textureSize(YCoCgColor, 0) - ivec2(1)), 0)');
   }
   const base=path.join(out,'sgsr2',convert?'convert':'upscale'),input=base+'.comp',spv=base+'.spv',metal=base+'.metal';
   fs.writeFileSync(input,text);
   run(compiler,['--library',options['--shaderc-library'],'--input',input,'--output',spv,'--language','glsl','--stage','compute']);
   run(path.join(tools,'spirv-val'),['--target-env','vulkan1.1',spv]);
   run(path.join(tools,'spirv-cross'),[spv,'--msl','--msl-version','23000','--output',metal]);
   const msl=fs.readFileSync(metal,'utf8'),entry=/kernel\s+void\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(msl);
   if(!entry)throw new Error('Translated Metal compute entry is missing.');
   const reflection=JSON.parse(run(path.join(tools,'spirv-cross'),[spv,'--reflect']));
   const bindings=[...entry[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)].map(match=>({name:match[1],kind:match[2],index:Number(match[3])}));
   const ubo=reflection.ubos.find(value=>value.name==='Params');
   if(!ubo||ubo.block_size!==136)throw new Error('SGSR uniform layout changed.');
   fs.writeFileSync(base+'.json',JSON.stringify({entry:entry[1],threads:reflection.entryPoints[0].workgroup_size,bindings,uniformBytes:ubo.block_size},null,2)+'\n');
   fs.rmSync(input);fs.rmSync(spv);
 }
 for(const arch of ['arm64','x86_64'])run('xcrun',['clang++','-std=c++17','-O2','-fobjc-arc','-arch',arch,'-mmacosx-version-min=13.0','-dynamiclib',path.join(app,'backend.mm'),'-framework','Metal','-framework','Foundation','-install_name','@rpath/libmaclauncher-sgsr2.dylib','-o',path.join(out,`libmaclauncher-sgsr2-${arch}.dylib`)]);
 const library=path.join(out,'libmaclauncher-sgsr2.dylib');
 run('lipo',['-create',...['arm64','x86_64'].map(arch=>path.join(out,`libmaclauncher-sgsr2-${arch}.dylib`)),'-output',library]);
 run('codesign',['--force','--sign','-',library]);
}
/** Add the notices and describe the compiled provider. */
function assemble(){
 addLicenses(out,'SGSR2',source);
 const files=fs.readdirSync(out,{recursive:true}).filter(relative=>!['provider.json','shaderc-offline','libmaclauncher-sgsr2-arm64.dylib','libmaclauncher-sgsr2-x86_64.dylib'].includes(relative)&&fs.statSync(path.join(out,relative)).isFile()).map(relative=>({path:relative,size:fs.statSync(path.join(out,relative)).size,sha256:hash(path.join(out,relative))}));
 const buildInputs={shadercLibrary:hash(options['--shaderc-library']),shadercHeader:hash(path.join(options['--shaderc-headers'],'shaderc/shaderc.h')),spirvCross:hash(path.join(tools,'spirv-cross')),spirvVal:hash(path.join(tools,'spirv-val'))};
 fs.writeFileSync(path.join(out,'provider.json'),JSON.stringify({providerABI:1,complete:true,methods:['sgsr2'],minimumMacOS:spec.minimumMacOS,architectures:['arm64','x86_64'],libraries:['libmaclauncher-sgsr2.dylib'],shaders:['sgsr2'],resourcePreparation:1,files,source:{repository:spec.repository,commit:revision},buildInputs},null,2)+'\n');
 console.log('Built SGSR2 Metal provider: '+out);
}
if(phase!=='assemble')compile();
if(phase!=='compile')assemble();
