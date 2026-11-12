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
  memory=replace(memory,'    return false;\n}\n\ntemplate <class Visit>\nvoid visitReadablePages', `    return false;
#else
    if (source == 0 || bytes > std::numeric_limits<std::uint64_t>::max() - source) return false;
    mach_vm_size_t copied = 0;
    return ::mach_vm_read_overwrite(::mach_task_self(), static_cast<mach_vm_address_t>(source), bytes,
        reinterpret_cast<mach_vm_address_t>(destination), &copied) == KERN_SUCCESS && copied == bytes;
#endif
}

template <class Visit>
void visitReadablePages`);
  memory=replace(memory,'        MEMORY_BASIC_INFORMATION memory{};\n        require(VirtualQuery(reinterpret_cast<const void*>(cursor), &memory, sizeof(memory)) == sizeof(memory), "cannot query guest memory after a failed committed read");\n        const bool readable = memory.State == MEM_COMMIT && (memory.Protect & (PAGE_GUARD | PAGE_NOACCESS)) == 0 && readableProtection(memory.Protect & 0xffu);\n        visit(offset, chunk, readable && readPages(destination + offset, cursor, chunk));',
   '#ifdef _WIN32\n        MEMORY_BASIC_INFORMATION memory{};\n        require(VirtualQuery(reinterpret_cast<const void*>(cursor), &memory, sizeof(memory)) == sizeof(memory), "cannot query guest memory after a failed committed read");\n        const bool readable = memory.State == MEM_COMMIT && (memory.Protect & (PAGE_GUARD | PAGE_NOACCESS)) == 0 && readableProtection(memory.Protect & 0xffu);\n        visit(offset, chunk, readable && readPages(destination + offset, cursor, chunk));\n#else\n        visit(offset, chunk, readPages(destination + offset, cursor, chunk));\n#endif');
  memory=replace(memory,'#ifdef _WIN32\n    if (GuestArena::GuestArenaCopyOwned_nid_no_patch(source, destination, bytes)) return;\n    visitReadablePages(destination, source, bytes,', '#if defined(_WIN32) || defined(__APPLE__)\n#ifdef _WIN32\n    if (GuestArena::GuestArenaCopyOwned_nid_no_patch(source, destination, bytes)) return;\n#endif\n    visitReadablePages(destination, source, bytes,');
  memory=replace(memory,'#ifdef _WIN32\n    bool same = false;\n    if (GuestArena::GuestArenaCompareOwned_nid_no_patch(address, expected, bytes, &same)) return same;\n    constexpr std::size_t ChunkBytes = 64 * PageBytes;', '#if defined(_WIN32) || defined(__APPLE__)\n#ifdef _WIN32\n    bool same = false;\n    if (GuestArena::GuestArenaCompareOwned_nid_no_patch(address, expected, bytes, &same)) return same;\n#endif\n    constexpr std::size_t ChunkBytes = 64 * PageBytes;');
  memory=replace(memory,'    std::memcpy(reinterpret_cast<void*>(address), source.data(), source.size());', `#ifdef __APPLE__
    GuestWriteWatch::GuestWriteWatchBeginHostWrite_nid_postfix(reinterpret_cast<const void*>(address), source.size());
#endif
    std::memcpy(reinterpret_cast<void*>(address), source.data(), source.size());
#ifdef __APPLE__
    GuestWriteWatch::GuestWriteWatchEndHostWrite_nid_postfix(reinterpret_cast<const void*>(address), source.size());
#endif`);
  memory=replace(memory,'        if (source.size() >= PageBytes) copyOwnBytes(address, source);\n        else std::memcpy(destination, source.data(), source.size());', '        copyOwnBytes(address, source);');
  memory=replace(memory,'        if (importMayWriteGuest) open.emplace(reinterpret_cast<void*>(first), static_cast<std::size_t>(stop - first));', '        if (importMayWriteGuest) open.emplace(reinterpret_cast<void*>(first), static_cast<std::size_t>(stop - first), GuestArena::HostWrite::Import{});');
  await fs.writeFile(memoryFile,memory);changes.push(memoryRelative);
  const arenaHeaderRelative='core/libs/prx/libc/include/GuestArena.hpp';
  const arenaHeaderFile=path.join(root,arenaHeaderRelative);
  let arenaHeader=await fs.readFile(arenaHeaderFile,'utf8');
  arenaHeader=replace(arenaHeader,'bool GuestArenaBeginHostWrite_nid_postfix(void* pointer, std::size_t bytes);',`bool GuestArenaBeginHostWrite_nid_postfix(void* pointer, std::size_t bytes);
#ifdef __APPLE__
bool GuestArenaBeginImportWrite_nid_postfix(void* pointer, std::size_t bytes);
#endif`);
  arenaHeader=replace(arenaHeader,'class HostWrite {\npublic:',`class HostWrite {
public:
#ifdef __APPLE__
    struct Import {};
    HostWrite(void* pointer, std::size_t bytes, Import) : pointer(pointer), bytes(bytes), open(GuestArenaBeginImportWrite_nid_postfix(pointer, bytes)) {}
#endif`);
  await fs.writeFile(arenaHeaderFile,arenaHeader);changes.push(arenaHeaderRelative);
  const arenaRelative='core/libs/prx/libc/src/GuestArena.cpp';
  const arenaFile=path.join(root,arenaRelative);
  let arena=await fs.readFile(arenaFile,'utf8');
  arena=replace(arena,'bool GuestArenaBeginHostWrite_nid_postfix(void* pointer, std::size_t bytes) {',`#ifdef __APPLE__
bool GuestArenaBeginImportWrite_nid_postfix(void* pointer, std::size_t bytes) {
    GuestWriteWatch::GuestWriteWatchBeginHostWrite_nid_postfix(pointer, bytes);
    return true;
}
#endif

bool GuestArenaBeginHostWrite_nid_postfix(void* pointer, std::size_t bytes) {`);
  await fs.writeFile(arenaFile,arena);changes.push(arenaRelative);
  const recorderRelative='core/libs/prx/libSceAgcDriver/Graphics/src/Recorder.cpp';
  const recorderFile=path.join(root,recorderRelative);
  let recorder=await fs.readFile(recorderFile,'utf8');
  recorder=replace(recorder,'#include "prx/libc/include/GuestAllocations.hpp"',`#include "prx/libc/include/GuestAllocations.hpp"
#ifdef __APPLE__
#include "prx/libc/include/GuestArena.hpp"
#endif`);
  recorder=replace(recorder,'void FlushForAccess(std::uint64_t address, std::size_t bytes) {',`#ifdef __APPLE__
void FlushForHostWrite(std::uintptr_t address, std::size_t bytes) {
    const GuestMemory::ReadSiteScope site(GuestMemory::ReadSite::Store);
    GuestMemory::TagGpuLockSite(GuestMemory::GpuLockSite::Hook);
    std::lock_guard gpu(GuestMemory::GpuMutex());
    GuestMemory::FlushGpuWrites(address, bytes);
}
#endif

void FlushForAccess(std::uint64_t address, std::size_t bytes) {`);
  recorder=replace(recorder,'    GuestMemory::SetFlushHook(&FlushForAccess);',`    GuestMemory::SetFlushHook(&FlushForAccess);
#ifdef __APPLE__
    GuestArena::GuestArenaSetHostWriteHook_nid_no_patch(&FlushForHostWrite);
#endif`);
  await fs.writeFile(recorderFile,recorder);changes.push(recorderRelative);
  for(const name of ['DarwinImage.hpp','DarwinModuleInfo.inc']) {
    const destination=path.join(base,'Module',name);
    await fs.copyFile(path.join(import.meta.dirname,name),destination);changes.push('core/libs/prx/libkernel/Module/'+name);
  }
  const edit=async(relative,transform)=>{
    const file=path.join(base,relative),original=await fs.readFile(file,'utf8');
    await fs.writeFile(file,transform(original));changes.push('core/libs/prx/libkernel/'+relative);
  };
  // Module ids follow the Mach-O header that the Darwin module-info implementation reports.
  await edit('Module/src/DynamicLoader.cpp',source=>replace(source,'        if (module->native == native) return static_cast<std::int32_t>(handle);',`#ifdef __APPLE__
        if (module->image == native) return static_cast<std::int32_t>(handle);
#else
        if (module->native == native) return static_cast<std::int32_t>(handle);
#endif`));
  // Upstream's Darwin module info reports a converted image's Mach-O __ELFn protection runs, fills no TLS fields
  // or initializer addresses, and pairs the host __TEXT,__eh_frame with the guest eh_frame_hdr. This
  // implementation reports the guest PT_LOAD, PT_TLS, PT_GNU_EH_FRAME and initializer data recorded in
  // __APS5DATA, with module ids keyed by Mach-O header as in the DynamicLoader edit above.
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

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * kernel-read host-write flush hook:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/ebb364010a68d94c0be645b543779eed953b0c0d
 * GPU mutex held across that flush:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/4e3bae9ba527da89a7d74163e0002c76f9ae2971
 * write-watch brackets around host stores:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/c589601fdf3b7149a65f40da7005e2e5e65d3a81
 */
