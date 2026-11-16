import {projectSharedHeaders} from './shared-headers.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import moltenvkRecord from '../../../../../../dependencies/moltenvk.json' with {type:'json'};
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {appPath,moduleFile} from '../../../../../../../tools/app-source.mjs';
const declared = JSON.parse(fs.readFileSync(new URL('./source.json', import.meta.url)));
// The MoltenVK release is declared once in the shared dependencies.
const {archiveFormat, ...link} = declared.vulkanLinkInput, moltenvk = moltenvkRecord;
export const source = {...declared, vulkanLinkInput: {version: moltenvk.version, library: link.library, file: link.file, sha256: moltenvk.sha256,
  architecture: link.architecture, source: moltenvk.source, archive: {...moltenvk.archive, format: archiveFormat}, usage: link.usage}};
source.archive = JSON.parse(fs.readFileSync(new URL('../../../../../../dependencies/' + source.archiveDependency + '.json', import.meta.url)));
const here = import.meta.dirname, app = appPath('src/modules/crossover/temporal/vulkan');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const modulePath = 'dlls/winevulkan/';
function replaceOnce(text, before, after) {
    if (text.split(before).length !== 2) throw Error('The WineVulkan source anchor changed.');
    return text.replace(before, after);
}
export function unixTables(text) {
    const result = [];
    const re = /const unixlib_entry_t (__wine_unix_call(?:_wow64)?_funcs)\[\]\s*=[^{}]*\{\n([\s\S]*?)\n\};/g;
    for (const match of text.matchAll(re)) result.push({name:match[1],body:match[2],entries:match[2].split('\n').map(x=>x.trim()).filter(Boolean)});
    return result;
}
export function sharedHeaderInputs(profile=source) {
    const entries=new Set(profile.sharedHeaders);
    for(const name of profile.ownedFiles.filter(name=>/\.(?:c|h)$/.test(name))) {
        const text=fs.readFileSync(moduleFile('src/modules/crossover/temporal/vulkan/'+name),'utf8');
        for(const match of text.matchAll(/^\s*#\s*include\s*"macfx-shared\/([^"]+)"/gm))entries.add(match[1]);
    }
    return projectSharedHeaders(path.resolve(app,'../../../shared'),entries);
}
export function profileSources(directory,profile=source) {
    directory = fs.realpathSync(directory);
    for (const [file, expected] of Object.entries(profile.originalFiles))
        if (hash(fs.readFileSync(path.join(directory, file))) !== expected)
            throw Error('The Wine source profile differs: '+file);
    const original = file => fs.readFileSync(path.join(directory,modulePath,file),'utf8');
    const enumBefore = original('loader_thunks.h');
    const enumEntries = enumBefore.match(/enum unix_call\s*\{([\s\S]*?)\};/)?.[1].split('\n').map(x=>x.trim()).filter(x=>x.startsWith('unix_')&&x!=='unix_count,');
    const tablesBefore = unixTables(original('vulkan_thunks.c'));
    if (enumEntries?.length!==profile.unixCallCount || tablesBefore.length!==2 || tablesBefore.some(x=>x.entries.length!==profile.unixCallCount))
        throw Error('The original WineVulkan Unix-call layout differs.');
    const files = new Map();
    files.set(modulePath+'loader_thunks.h',replaceOnce(enumBefore,'    unix_count,','    unix_maclauncher_scene_record,\n    unix_count,'));
    let native = replaceOnce(original('vulkan_thunks.c'),'#include "vulkan_private.h"','#include "vulkan_private.h"\n#include "scene-request.h"');
    for (let i=0;i<tablesBefore.length;i++) {
        const body = tablesBefore[i].body;
        native = replaceOnce(native,body+'\n};',body+'\n    maclauncher_scene_record'+(i===0?'64':'32')+',\n};');
    }
    const tablesAfter = unixTables(native);
    if (tablesAfter.some((table,i)=>JSON.stringify(table.entries.slice(0,profile.unixCallCount))!==JSON.stringify(tablesBefore[i].entries)||table.entries.length!==profile.unixCallCount+1))
        throw Error('The original WineVulkan call indices changed.');
    files.set(modulePath+'vulkan_thunks.c',native);
    let vulkan = replaceOnce(original('vulkan.c'),'#include "vulkan_private.h"','#include "vulkan_private.h"\n#include "scene-request.h"');
    vulkan = replaceOnce(vulkan,'static NTSTATUS is_available_device_function(VkDevice handle, const char *name)\n{',
        'static NTSTATUS is_available_device_function(VkDevice handle, const char *name)\n{\n    if (name && !strcmp(name, "MacLauncherWineVulkanSceneABI1")) return RS_WINE_VULKAN_SCENE_PROFILE;');
    files.set(modulePath+'vulkan.c',vulkan);
    files.set(modulePath+'loader.c',original('loader.c')+'\nBOOL maclauncher_scene_initialize(void)\n{\n    return wine_vk_init_once();\n}\n');
    files.set(modulePath+'Makefile.in',replaceOnce(original('Makefile.in'),'SOURCES = \\\n','SOURCES = \\\n\tscene-pe.c \\\n\tscene-unix.c \\\n'));
    files.set(modulePath+'winevulkan.spec',original('winevulkan.spec')+'\n@ stdcall MacLauncherWineVulkanSceneAPI1()\n@ stdcall MacLauncherWineVulkanRecordScene1(ptr)\n@ stdcall MacLauncherWineVulkanSceneContext1(ptr)\n');
    for (const name of profile.ownedFiles.filter(name=>/\.(?:c|h)$/.test(name))) {
        if (fs.existsSync(path.join(directory,modulePath,name))) throw Error('The original source already contains an owned WineVulkan entry.');
        let owned=fs.readFileSync(path.join(app,name),'utf8');
        if(name==='scene-unix.c')owned=replaceOnce(owned,'WINE_VULKAN_DRIVER_VERSION == 47','WINE_VULKAN_DRIVER_VERSION == '+profile.wineVulkanDriverVersion);
        files.set(modulePath+name,owned);
    }
    // The matched Wine header already declares the exact Vulkan C types.
    if (fs.existsSync(path.join(directory,'include/vulkan/vulkan.h'))) throw Error('The Vulkan header layout changed.');
    files.set('include/vulkan/vulkan.h','#pragma once\n#include "wine/vulkan.h"\n');
    for (const [file,bytes] of sharedHeaderInputs(profile))
        files.set(modulePath+'macfx-shared/'+file,bytes);
    return {files,originalCalls:profile.unixCallCount,calls:profile.unixCallCount+1};
}
export function applyProfile(directory,profile=source) {
    const result = profileSources(directory,profile);
    for (const [file,bytes] of result.files) {
        const target=path.join(directory,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
    }
    return {profile:profile.profile,originalCalls:result.originalCalls,calls:result.calls,files:[...result.files.keys()]};
}
