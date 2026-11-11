import {appPath,appSourceRoot} from '../../../../../../tools/app-source.mjs';
import moltenvkRecord from '../../../../../dependencies/moltenvk.json' with {type:'json'};
import {addLicenses} from '../../../../../../lib/licenses.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isolateCompiler} from './compiler-isolation.mjs';
import {buildSceneLibrary} from './libplacebo/scene-source.mjs';
import {buildDependencies,dependencyRecords,profile} from './libplacebo/dependencies-build.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url)),repository=path.resolve(directory,'../../../..');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run=(program,args)=>execFileSync(program,args,{stdio:'pipe',encoding:'utf8'});
export const MOLTENVK=Object.freeze(moltenvkRecord);
function inventory(output){const files=[];function visit(relative=''){for(const row of fs.readdirSync(path.join(output,relative),{withFileTypes:true})){const file=relative?relative+'/'+row.name:row.name;if(row.isDirectory())visit(file);else if(file!=='provider.json')files.push({path:file,size:fs.statSync(path.join(output,file)).size,sha256:hash(path.join(output,file))});}}visit();return files.sort((a,b)=>a.path.localeCompare(b.path));}
const sceneName=architecture=>architecture==='arm64'?'scene-source.json':'scene-source.x86_64.json';
/** Build one CPU's libraries, provider and helper, and describe its scene library. */
function compileProvider({moltenvk,headers,output,sceneLibrary,dependencies,architecture}){
 if(fs.existsSync(output))throw Error('Choose a new libplacebo output directory.');
 if(sceneLibrary.architecture!==architecture)throw Error('The source-built libplacebo library targets a different architecture.');
 const lib=path.join(output,'libplacebo');fs.mkdirSync(lib,{recursive:true});
 const mvk=path.join(moltenvk,'MoltenVK/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib');
 const inputs=[['libplacebo.360.dylib',sceneLibrary.library],['libshaderc_shared.1.dylib',path.join(dependencies.inputs,'shaderc/shaderc/'+profile.shadercVersion+'/lib/libshaderc_shared.1.dylib')],['liblcms2.2.dylib',path.join(dependencies.inputs,'little-cms2/little-cms2/'+profile.lcmsVersion+'/lib/liblcms2.2.dylib')],['libMoltenVK.dylib',mvk]];
 for(const [name,source]of inputs){const file=path.join(lib,name);fs.copyFileSync(source,file);fs.chmodSync(file,0o755);run('install_name_tool',['-id','@rpath/'+(name==='libplacebo.360.dylib'?'libplacebo/':'')+name,file]);
  for(const line of run('otool',['-arch',architecture,'-L',file]).split('\n').slice(2)){const dependency=line.trim().split(' (')[0];if(!dependency||dependency.startsWith('/System/')||dependency.startsWith('/usr/lib/'))continue;let next=path.basename(dependency);if(next.startsWith('liblcms2.'))next='liblcms2.2.dylib';if(next.startsWith('libvulkan.'))next='libMoltenVK.dylib';if(dependency!=='@loader_path/'+next)run('install_name_tool',['-change',dependency,'@loader_path/'+next,file]);}
  if(name==='libshaderc_shared.1.dylib')isolateCompiler(file,[['pirv_cross','pplc_cross'],['spvtools','spvplctl'],['glslang','mclplcg'],['3spv','3plv']]);run('codesign',['--force','-s','-',file]);}
 const {library:_library,include:_include,...provenance}=sceneLibrary;fs.writeFileSync(path.join(output,sceneName(architecture)),JSON.stringify(provenance,null,2)+'\n');
 const native=appPath('src/modules/shared/reshade/native'),common=['clang++','-std=c++17','-O2','-fobjc-arc','-Wno-deprecated-declarations','-Werror=unguarded-availability-new','-DVK_USE_PLATFORM_METAL_EXT','-DMACFX_LIBPLACEBO_SCENE_INPUTS=1','-arch',architecture,'-mmacosx-version-min='+profile.minimumMacOS,'-ffile-prefix-map='+repository+'=.','-ffile-prefix-map='+appSourceRoot().directory+'=.','-ffile-prefix-map='+headers+'=upstream','-I'+native,'-I'+headers,'-I'+sceneLibrary.include,'-I'+path.join(moltenvk,'MoltenVK/MoltenVK/include')];
 const provider=path.join(output,'libmacfx-libplacebo.dylib');run('xcrun',[...common,'-dynamiclib',path.join(native,'libplacebo-node.mm'),'-L'+lib,'-lplacebo.360','-lMoltenVK','-Wl,-rpath,@loader_path/libplacebo','-Wl,-rpath,@loader_path','-Wl,-install_name,@rpath/libmacfx-libplacebo.dylib','-framework','Foundation','-framework','Metal','-o',provider]);
 const helper=path.join(output,'libplacebo-prepare');run('xcrun',[...common,path.join(native,'libplacebo-prepare.mm'),'-L'+output,'-lmacfx-libplacebo','-Wl,-rpath,@executable_path','-framework','Foundation','-framework','Metal','-o',helper]);for(const file of[provider,helper]){run('strip',['-x',file]);run('codesign',['--force','-s','-',file]);}
}
async function compileArchitecture(options){
 const {work,output,arch,meson,ninja,python,dependencySources}=options,architecture=arch==='x64'?'x86_64':'arm64';if(!work||fs.existsSync(work))throw Error('Choose an unused source build workspace.');fs.mkdirSync(work,{recursive:true});
 const dependencies=buildDependencies({work:path.join(work,'dependencies'),architecture,meson,ninja,python,sources:dependencySources});
 const library=buildSceneLibrary({...options,inputs:dependencies.inputs,dependencyHeaders:dependencies.inputs,architecture,output:path.join(work,architecture),python});
 compileProvider({...options,output,sceneLibrary:library,dependencies,architecture});
}
async function compileUniversal(options){
 const {work,output}=options;if(fs.existsSync(work)||fs.existsSync(output))throw Error('Choose new Universal source/output directories.');fs.mkdirSync(work,{recursive:true});
 const stages=[];for(const arch of['arm64','x64']){const stage=path.join(work,arch+'-provider');await compileArchitecture({...options,arch,work:path.join(work,arch+'-work'),output:stage});stages.push(stage);}
 combineStages(stages,output);
}
/** Build the provider for the selected CPUs. */
async function compile(options,universal){
 await (universal?compileUniversal(options):compileArchitecture(options));
}
function combineStages(stages,output){
 fs.mkdirSync(output,{recursive:true});fs.cpSync(stages[0],output,{recursive:true});
 for(const row of inventory(stages[0])){const destination=path.join(output,row.path);if((row.path.endsWith('.dylib')||row.path==='libplacebo-prepare')&&hash(path.join(stages[0],row.path))!==hash(path.join(stages[1],row.path))){run('lipo',['-create',...stages.map(stage=>path.join(stage,row.path)),'-output',destination+'.fat']);fs.renameSync(destination+'.fat',destination);run('codesign',['--force','-s','-',destination]);}}
 fs.copyFileSync(path.join(stages[1],sceneName('x86_64')),path.join(output,sceneName('x86_64')));
}
/** Add the notices and describe the compiled provider from its helper's filter catalog, its scene descriptions and declared inputs. */
function describe({moltenvk,source,dependencySources,work,output,architectures}){
 addLicenses(output,'MoltenVK',moltenvk);
 addLicenses(output,'libplacebo',source);
 const dependencyLicenses=path.join(work,'dependency-licenses');for(const row of profile.sources)addLicenses(dependencyLicenses,row.id,path.join(dependencySources,row.id));
 addLicenses(output,'compiler-dependencies',dependencyLicenses);
 const catalog=JSON.parse(run(path.join(output,'libplacebo-prepare'),['--filters']));
 const inputs=architectures.flatMap(architecture=>{const scene=JSON.parse(fs.readFileSync(path.join(output,sceneName(architecture)),'utf8'));
  return [{name:'libplacebo',...scene.source,architecture,sha256:scene.sha256,headerInputs:scene.headerInputs,source:scene.source.origin,dependencies:[scene.vulkanHeaders,...(scene.fastFloat?[scene.fastFloat]:[])]},...dependencyRecords().map(row=>({...row,name:row.id,architecture})),{name:'MoltenVK',...MOLTENVK}];});
 const metadata={schema:1,provider:'libplacebo',version:'7.360.1',derivedPlanes:true,imageFiltersAPI:catalog.imageFiltersAPI,imageFilters:catalog.imageFilters,sceneInputsAPI:catalog.sceneInputsAPI||0,sceneInputRoles:catalog.sceneInputRoles||[],architectures,minimumMacOS:profile.minimumMacOS,library:'libmacfx-libplacebo.dylib',helper:'libplacebo-prepare',filters:catalog.filters,files:inventory(output),inputs};fs.writeFileSync(path.join(output,'provider.json'),JSON.stringify(metadata,null,2)+'\n');return metadata;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={};for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i].replace(/^--/,'').replace(/-([a-z])/g,(_m,c)=>c.toUpperCase());if(!['moltenvk','headers','output','source','vulkanSource','dependencySources','work','meson','ninja','python','arch','phase'].includes(name)||!process.argv[i+1])throw Error('Expected explicit build input paths.');options[name]=['arch','phase'].includes(name)?process.argv[i+1]:path.resolve(process.argv[i+1]);}
 for(const name of['source','vulkanSource','dependencySources','moltenvk','headers','output','work','meson','ninja'])if(!options[name])throw Error('Missing '+name);
 if(options.phase&&!['compile','assemble'].includes(options.phase))throw Error('Choose the compile or assemble phase.');
 const universal=!options.arch||options.arch==='universal',architectures=universal?['arm64','x86_64']:[options.arch==='x64'?'x86_64':'arm64'];
 (async()=>{if(options.phase!=='assemble')await compile(options,universal);if(options.phase!=='compile')return describe({...options,architectures});})()
  .then(result=>{if(result)console.log(JSON.stringify(result,null,2));}).catch(error=>{console.error(error);process.exitCode=1;});
}
