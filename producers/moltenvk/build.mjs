import {appPath,recipePath} from '../../tools/app-source.mjs';
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname;
const run=(program,args,options={})=>execFileSync(program,args,{stdio:'inherit',...options});
// The producer's declaration is authoritative. Do not maintain a second wire layout.
export function carrierHeader(producer=path.resolve(here,'../vkd3d-proton/vk_temporal_frame.h')){
    // The frame and its chained masks, through the last carrier structure.
    const end='} VkTemporalFrameMasksInfoMVK;',text=fs.readFileSync(producer,'utf8'),first=text.indexOf('#define VK_STRUCTURE_TYPE_TEMPORAL_FRAME_INFO_MVK'),last=text.indexOf(end,first);
    if(first<0||last<0)throw Error('Missing shared temporal carrier declaration');
    return '// Generated from the shared LGPL-2.1-or-later temporal carrier.\n#pragma once\n#include <vulkan/vulkan.h>\n'+text.slice(first,last+end.length)+'\n';
}
// Compose the carrier in an owned source projection; the upstream checkout stays read-only.
// The temporal carrier sources the projection applies: the patch, then the command headers.
export const temporalSources=['app:src/modules/shared/vulkan/native/temporal.patch','app:src/modules/shared/vulkan/native/temporal-command.hpp','app:src/modules/shared/vulkan/native/temporal-command.inc','app:src/modules/shared/vulkan/native/temporal-map.hpp','app:src/modules/shared/vulkan/native/temporal-scene.hpp'];
export function applyTemporalSource(work){
    const [patch,...headers]=temporalSources.map(file=>recipePath(here,file));
    run('git',['apply','--unsafe-paths','--directory='+work,patch]);
    const commands=path.join(work,'MoltenVK/MoltenVK/Commands');
    for(const header of headers)fs.copyFileSync(header,path.join(commands,path.basename(header)));
    fs.writeFileSync(path.join(commands,'temporal-carrier.h'),carrierHeader());
    const scene=appPath('src/modules/shared/reshade');
    const common=path.join(work,'MoltenVK/include/macfx-temporal');
    fs.mkdirSync(common,{recursive:true});
    for(const [name,directory]of [['frame.h','temporal'],['scene-aovs.h','temporal'],['scene-matrices.h','temporal'],['image-color.h','native']]){
        fs.copyFileSync(path.join(scene,directory,name),path.join(common,name));
        fs.writeFileSync(path.join(commands,name),'#pragma once\n#include "../../include/macfx-temporal/'+name+'"\n');
    }
    const commandPath='MoltenVK/MoltenVK/Commands/';
    return [...fs.readFileSync(patch,'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m=>m[1]).concat(
        ['temporal-command.hpp','temporal-command.inc','temporal-map.hpp','temporal-scene.hpp','temporal-carrier.h','frame.h','scene-aovs.h','scene-matrices.h','image-color.h'].map(file=>commandPath+file),
        ['frame.h','scene-aovs.h','scene-matrices.h','image-color.h'].map(file=>'MoltenVK/include/macfx-temporal/'+file));
}
