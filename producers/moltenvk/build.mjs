import {appPath} from '../../tools/app-source.mjs';
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {addLicenses} from '../../lib/licenses.mjs';
const here=import.meta.dirname;
export const sourceProfile=JSON.parse(fs.readFileSync(path.join(here,'source.json')));
export const revision=sourceProfile.revision;
const run=(program,args,options={})=>execFileSync(program,args,{stdio:'inherit',...options});
const read=(program,args)=>execFileSync(program,args,{encoding:'utf8'}).trim();
// The producer's declaration is authoritative. Do not maintain a second wire layout.
export function carrierHeader(producer=path.resolve(here,'../vkd3d-proton/vk_temporal_frame.h')){
    // The frame and its chained masks, through the last carrier structure.
    const end='} VkTemporalFrameMasksInfoMVK;',text=fs.readFileSync(producer,'utf8'),first=text.indexOf('#define VK_STRUCTURE_TYPE_TEMPORAL_FRAME_INFO_MVK'),last=text.indexOf(end,first);
    if(first<0||last<0)throw Error('Missing shared temporal carrier declaration');
    return '// Generated from the shared LGPL-2.1-or-later temporal carrier.\n#pragma once\n#include <vulkan/vulkan.h>\n'+text.slice(first,last+end.length)+'\n';
}
// Compose the carrier in an owned source projection; the upstream checkout stays read-only.
export function applyTemporalSource(work){
    const vulkan=appPath('src/modules/shared/vulkan/native');
    run('git',['apply','--unsafe-paths','--directory='+work,path.join(vulkan,'temporal.patch')]);
    const commands=path.join(work,'MoltenVK/MoltenVK/Commands');
    for(const name of ['temporal-command.hpp','temporal-command.inc','temporal-map.hpp','temporal-scene.hpp'])fs.copyFileSync(path.join(vulkan,name),path.join(commands,name));
    fs.writeFileSync(path.join(commands,'temporal-carrier.h'),carrierHeader());
    const scene=appPath('src/modules/shared/reshade');
    const common=path.join(work,'MoltenVK/include/macfx-temporal');
    fs.mkdirSync(common,{recursive:true});
    for(const [name,directory]of [['frame.h','temporal'],['scene-aovs.h','temporal'],['scene-matrices.h','temporal'],['image-color.h','native']]){
        fs.copyFileSync(path.join(scene,directory,name),path.join(common,name));
        fs.writeFileSync(path.join(commands,name),'#pragma once\n#include "../../include/macfx-temporal/'+name+'"\n');
    }
    const commandPath='MoltenVK/MoltenVK/Commands/';
    return [...fs.readFileSync(appPath('src/modules/shared/vulkan/native/temporal.patch'),'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m=>m[1]).concat(
        ['temporal-command.hpp','temporal-command.inc','temporal-map.hpp','temporal-scene.hpp','temporal-carrier.h','frame.h','scene-aovs.h','scene-matrices.h','image-color.h'].map(file=>commandPath+file),
        ['frame.h','scene-aovs.h','scene-matrices.h','image-color.h'].map(file=>'MoltenVK/include/macfx-temporal/'+file));
}
export function prepareSource({source,work}){
    if(read('git',['-C',source,'rev-parse',revision+'^{commit}'])!==revision)throw Error('Missing pinned MoltenVK source');
    source=fs.realpathSync(source);work=path.resolve(work);
    if(work===source||work.startsWith(source+path.sep)||source.startsWith(work+path.sep))throw Error('Owned build and upstream source must be separate');
    if(fs.existsSync(work))throw Error('Prepared source directory already exists');
    fs.mkdirSync(work,{recursive:true});
    const archive=path.join(work,'source.tar');run('git',['-C',source,'archive',revision,'-o',archive]);
    run('tar',['-xf',archive,'-C',work]);fs.unlinkSync(archive);
    applyTemporalSource(work);
    return work;
}
export function buildProvider({source,work,output,spirvCross,vulkanHeaders,cereal,architecture='x86_64',jobs=2}){
    jobs=Number(jobs);if(!Number.isInteger(jobs)||jobs<1||jobs>2)throw Error('Build concurrency must be 1 or 2');
    if(!['arm64','x86_64'].includes(architecture))throw Error('Unknown target architecture');
    for(const item of [spirvCross,vulkanHeaders,cereal])if(!item)throw Error('Missing declared source dependency');
    const projected=prepareSource({source,work:path.join(work,'source')});
    // All upstream-selected inputs are exact; no source fetching occurs in this recipe.
    for(const[name,directory]of [['SPIRV-Cross',spirvCross],['Vulkan-Headers',vulkanHeaders],['cereal',cereal]]){
        const expected=fs.readFileSync(path.join(projected,'ExternalRevisions',name+'_repo_revision'),'utf8').trim();
        if(read('git',['-C',directory,'rev-parse','HEAD'])!==expected)throw Error('Incorrect '+name+' source revision');
    }
    const build=path.join(work,'build');
    run('cmake',['-S',here,'-B',build,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES='+architecture,
        '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DMACFX_MOLTENVK_SOURCE='+projected,
        '-DMACFX_SPIRV_CROSS_SOURCE='+path.resolve(spirvCross),'-DMACFX_VULKAN_HEADERS_SOURCE='+path.resolve(vulkanHeaders),
        '-DMACFX_CEREAL_SOURCE='+path.resolve(cereal)]);
    fs.writeFileSync(path.join(build,'upstream/MoltenVK/mvkGitRevDerived.h'),'static const char* mvkRevString = \"'+revision+'\";\n');
    run('cmake',['--build',build,'--target','MoltenVK','--parallel',String(jobs)]);
    if(fs.existsSync(output))throw Error('Runtime output already exists');fs.mkdirSync(output,{recursive:true});
    const library=path.join(output,'libMoltenVK.dylib');fs.copyFileSync(path.join(build,'upstream/MoltenVK/libMoltenVK.dylib'),library);
    run('install_name_tool',['-id','@rpath/libMoltenVK.dylib',library]);run('codesign',['--force','--sign','-','--timestamp=none',library]);
    for(const[name,directory]of [['MoltenVK',projected],['SPIRV-Cross',spirvCross],['Vulkan-Headers',vulkanHeaders],['cereal',cereal],['MacLauncher',path.resolve(here,'../..')],['VKD3D-Proton',path.resolve(here,'../vkd3d-proton/source')]])addLicenses(output,name,directory);
    return {output,source:{repository:'https://github.com/KhronosGroup/MoltenVK.git',revision},architecture};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
    const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2);if(!['source','work','output','spirvCross','vulkanHeaders','cereal','architecture','jobs'].includes(key)||!process.argv[i+1])throw Error('Invalid build argument');options[key]=process.argv[i+1];}
    console.log(JSON.stringify(buildProvider(options)));
}
