import fs from 'node:fs/promises';
import path from 'node:path';
import { applyBindingsOverlay } from './bindings.mjs';

function replace(source,before,after) {
  if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before)) throw new Error('AnyPS5 Darwin loader boundary changed: '+before.slice(0,80));
  return source.replace(before,after);
}
export async function applyLoaderOverlay(root) {
  const base=path.join(root,'core/libs/prx/libkernel'),changes=[];
  const imageRelative='core/relinker/elfpatcher/src/macos/MacOsImage.cpp';
  const imageFile=path.join(root,imageRelative);
  let image=await fs.readFile(imageFile,'utf8');
  image=replace(image,'    meta.resize(metaEnd, 0);',`    const auto lifecycle = AlignUp(metaEnd, 8);
    metaEnd = lifecycle + 24;
    meta.resize(metaEnd, 0);
    Io::WriteU64(meta, lifecycle, 1);
    if (input.InitRva != 0) {
        Io::WriteU64(meta, lifecycle + 8, imageBase + input.InitRva);
        input.Rebases.push_back(metaRva + static_cast<std::uint32_t>(lifecycle + 8));
    }
    if (input.FiniRva != 0) {
        Io::WriteU64(meta, lifecycle + 16, imageBase + input.FiniRva);
        input.Rebases.push_back(metaRva + static_cast<std::uint32_t>(lifecycle + 16));
    }`);
  image=replace(image,'    std::vector<Section> dataSections{{"__meta", 0, metaSize, 0, 3}};', '    std::vector<Section> dataSections{{"__meta", 0, metaSize, 0, 3}, {"__init_fini", lifecycle, 24, 0, 3}};');
  await fs.writeFile(imageFile,image);changes.push(imageRelative);
  for (const [name,relative] of [
    ['HostMapping.hpp','core/libs/prx/libc/include/specifics/HostMapping.hpp'],
    ['DarwinHostMapping.hpp','core/libs/prx/libc/include/specifics/macos/HostMapping.hpp'],
    ['DarwinVirtualMemory.hpp','core/libs/prx/libc/include/specifics/macos/VirtualMemory.hpp']
  ]) {
    const destination=path.join(root,relative);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.copyFile(path.join(import.meta.dirname,name),destination);changes.push(relative);
  }
  for (const relative of ['core/libs/prx/libSceSysmodule/Export.cpp','core/libs/prx/libSceAgcDriver/Execution/src/GuestMemory.cpp']) {
    const file=path.join(root,relative),source=await fs.readFile(file,'utf8');
    await fs.writeFile(file,replace(source,'specifics/linux/HostMapping.hpp','specifics/HostMapping.hpp'));changes.push(relative);
  }
  const memoryRelative='core/libs/prx/libSceAgcDriver/Execution/src/GuestMemory.cpp';
  const memoryFile=path.join(root,memoryRelative);
  let memory=await fs.readFile(memoryFile,'utf8');
  memory=replace(memory,'#ifdef _WIN32\nbool readPages(std::byte* destination, std::uint64_t source, std::size_t bytes) {', '#if defined(_WIN32) || defined(__APPLE__)\nbool readPages(std::byte* destination, std::uint64_t source, std::size_t bytes) {\n#ifdef _WIN32');
  memory=replace(memory,'    return ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<const void*>(source), destination, bytes, &copied) != 0 && copied == bytes;\n}', `    return ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<const void*>(source), destination, bytes, &copied) != 0 && copied == bytes;
#else
    if (source == 0 || bytes > std::numeric_limits<std::uint64_t>::max() - source) return false;
    mach_vm_size_t copied = 0;
    return ::mach_vm_read_overwrite(::mach_task_self(), static_cast<mach_vm_address_t>(source), bytes,
        reinterpret_cast<mach_vm_address_t>(destination), &copied) == KERN_SUCCESS && copied == bytes;
#endif
}`);
  memory=replace(memory,'#ifdef _WIN32\n    visitReadablePages(destination, source, bytes,', '#if defined(_WIN32) || defined(__APPLE__)\n    visitReadablePages(destination, source, bytes,');
  memory=replace(memory,'#ifdef _WIN32\n    constexpr std::size_t ChunkBytes = 64 * PageBytes;', '#if defined(_WIN32) || defined(__APPLE__)\n    constexpr std::size_t ChunkBytes = 64 * PageBytes;');
  await fs.writeFile(memoryFile,memory);changes.push(memoryRelative);
  for(const name of ['DarwinImage.hpp','DarwinModuleInfo.inc']) {
    const destination=path.join(base,'Module',name);
    await fs.copyFile(path.join(import.meta.dirname,name),destination);changes.push('core/libs/prx/libkernel/Module/'+name);
  }
  const edit=async(relative,transform)=>{
    const file=path.join(base,relative),original=await fs.readFile(file,'utf8');
    await fs.writeFile(file,transform(original));changes.push('core/libs/prx/libkernel/'+relative);
  };
  await edit('Module/src/DynamicLoader.cpp',source=>{
    source=replace(source,'#include <link.h>','#ifdef __APPLE__\n#include "prx/libkernel/Module/DarwinImage.hpp"\n#else\n#include <link.h>\n#endif');
    source=replace(source,'    bool global = false;','    bool global = false;\n#ifdef __APPLE__\n    const DarwinImage::Header* image = nullptr;\n#endif');
    source=replace(source,'#ifndef _WIN32\nconst link_map* MainProgramMap()',`#if defined(__APPLE__)
bool FromGuestModule(void* address) {
    const auto* image = DarwinImage::Containing(address);
    return image && DarwinImage::Guest(image);
}
void* DefaultScopeSymbol(const char* symbolName) {
    auto* result = ::dlsym(RTLD_DEFAULT,symbolName);
    return FromGuestModule(result) ? result : nullptr;
}
#elif !defined(_WIN32)
const link_map* MainProgramMap()`);
    source=replace(source,'#ifdef __linux__\n        if (path) InitializeLinuxGuestModule(module->native);\n#endif',`#ifdef __APPLE__
        module->image = path ? DarwinImage::FindPath(resolved) : DarwinImage::Main();
#elif defined(__linux__)
        if (path) InitializeLinuxGuestModule(module->native);
#endif`);
    source=replace(source,'#else\n        mutation.UnregisterImage(reinterpret_cast<const void*>(static_cast<link_map*>(module->native)->l_addr));',`#elif defined(__APPLE__)
        mutation.UnregisterImage(reinterpret_cast<const void*>(DarwinImage::LoadBias(module->image)));
#else
        mutation.UnregisterImage(reinterpret_cast<const void*>(static_cast<link_map*>(module->native)->l_addr));`);
    source=replace(source,'        if (module->native == native) return static_cast<std::int32_t>(handle);',`#ifdef __APPLE__
        if (module->image == native) return static_cast<std::int32_t>(handle);
#else
        if (module->native == native) return static_cast<std::int32_t>(handle);
#endif`);
    return source;
  });
  await edit('System/src/Rtld.cpp',source=>{
    source=replace(source,'#include <link.h>','#ifdef __APPLE__\n#include "prx/libkernel/Module/DarwinImage.hpp"\n#else\n#include <link.h>\n#endif');
    source=replace(source,'#else\n    Dl_info info{};',`#elif defined(__APPLE__)
    const auto* image = DarwinImage::Containing(address);
    if (!image) return nullptr;
    if (reference && image != DarwinImage::Main()) {
        const auto path = DarwinImage::Path(image);
        handle = ::dlopen(path.c_str(),RTLD_LAZY | RTLD_NOLOAD);
        if (!handle) throw std::runtime_error(std::string(caller) + ": cannot reference " + path);
    }
    return image;
#else
    Dl_info info{};`);
    return source;
  });
  await edit('Module/src/ModuleInfo.cpp',source=>'#ifdef __APPLE__\n#include "prx/libkernel/Module/DarwinModuleInfo.inc"\n#else\n'+source+'\n#endif\n');
  await edit('Module/src/Module.cpp',source=>{
    source=replace(source,'specifics/linux/HostMapping.hpp','specifics/HostMapping.hpp');
    source=replace(source,'#elif defined(__APPLE__)\n#include <dlfcn.h>','#elif defined(__APPLE__)\n#include <dlfcn.h>\n#include "prx/libc/include/specifics/HostMapping.hpp"');
    const start=source.indexOf('#elif defined(__APPLE__)\n  struct Search {'),end=source.indexOf('\n#else\n  const auto mapping = HostMapping::Find',start);
    if(start<0||end<0) throw new Error('AnyPS5 Darwin unwind boundary changed');
    return source.slice(0,start)+`#elif defined(__APPLE__)
  ModuleInfoEx image{};
  image.st_size = sizeof(image);
  const int status = sceKernelGetModuleInfoFromAddr(addr,1,&image);
  if (status != 0) {
    if (status != SCE_KERNEL_ERROR_ESRCH) return status;
    const auto mapping = HostMapping::Find(addr,"sceKernelGetModuleInfoForUnwind");
    if (!mapping) return status;
    info->st_size = sizeof(ModuleInfoForUnwind);
    std::strncpy(info->name,mapping->path.c_str(),sizeof(info->name) - 1);
    info->name[sizeof(info->name) - 1] = '\\0';
    info->eh_frame_hdr_addr = 0;
    info->eh_frame_addr = 0;
    info->eh_frame_size = 0;
    info->seg0_addr = mapping->start;
    info->seg0_size = mapping->end - mapping->start;
    return 0;
  }
  info->st_size = sizeof(ModuleInfoForUnwind);
  std::memcpy(info->name,image.name,sizeof(info->name));
  info->eh_frame_hdr_addr = image.eh_frame_hdr_addr;
  info->eh_frame_addr = image.eh_frame_addr;
  info->eh_frame_size = image.eh_frame_size;
  if (image.segment_count == 0) return SCE_KERNEL_ERROR_ESRCH;
  info->seg0_addr = image.segments[0].address;
  info->seg0_size = image.segments[0].size;
  return 0;`+source.slice(end);
  });
  changes.push(...await applyBindingsOverlay(root));
  return [...new Set(changes)];
}
