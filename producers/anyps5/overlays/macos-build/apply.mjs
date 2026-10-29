import fs from 'node:fs';
import path from 'node:path';
function replaceOnce(text,before,after,file){
 if(text.indexOf(before)<0||text.indexOf(before)!==text.lastIndexOf(before))throw Error('AnyPS5 macOS build overlay does not match '+file);
 return text.replace(before,after);
}
export function applyBuildOverlay(projectionRoot){
 const changes=[];
 const edit=(relative,adapt)=>{const file=path.join(projectionRoot,relative),before=fs.readFileSync(file,'utf8'),after=adapt(before,relative);if(before!==after){fs.writeFileSync(file,after);changes.push(relative);}};
 edit('core/libs/prx/libc/src/exception/StandardExceptions.cpp',(text,file)=>replaceOnce(text,'reinterpret_cast<Condition>(static_cast<const void* const*>(self->vtable)[4])','reinterpret_cast<Condition>(const_cast<void*>(static_cast<const void* const*>(self->vtable)[4]))',file));
 edit('core/libs/prx/libkernel/File/src/NativeStat.cpp',(text,file)=>{
  text=replaceOnce(text,'#else\n    sb->st_dev = static_cast<std::uint32_t>(st.st_dev);',
   '#else\n#if defined(__APPLE__)\n    const auto& hostAccess = st.st_atimespec;\n    const auto& hostModified = st.st_mtimespec;\n    const auto& hostChanged = st.st_ctimespec;\n#else\n    const auto& hostAccess = st.st_atim;\n    const auto& hostModified = st.st_mtim;\n    const auto& hostChanged = st.st_ctim;\n#endif\n    sb->st_dev = static_cast<std::uint32_t>(st.st_dev);',file);
  return text.replaceAll('>(st.st_atim.','>(hostAccess.').replaceAll('>(st.st_mtim.','>(hostModified.').replaceAll('>(st.st_ctim.','>(hostChanged.');
 });
 edit('core/libs/prx/libSceAgcDriver/Execution/src/Driver/Lifecycle.cpp',(text,file)=>{
  for (const [name,value] of [
   ['DriverMemoryAddress','0xfe0000000ull + GuestArena::GuestAddressOffset'],
   ['FsTableAddress','DriverMemoryAddress + 0x40000ull'],
   ['FsRoutineTableAddress','FsTableAddress + FsTableSlots * FsTableSlotBytes'],
   ['FsRoutineAddress','FsRoutineTableAddress + FsRoutineTableBytes'],
  ]) text=replaceOnce(text,'constexpr std::uint64_t '+name+' = '+value+';',
   '#ifdef __APPLE__\nstd::uint64_t '+name+' = 0;\n#else\nconstexpr std::uint64_t '+name+' = '+value+';\n#endif',file);
  text=replaceOnce(text,'#else\n    mapped = mmap(reinterpret_cast<void*>(DriverMemoryAddress)',
   '#elif defined(__APPLE__)\n    mapped = GuestArena::GuestArenaAllocate_nid_postfix(DriverMemoryBytes, DriverMemoryBytes);\n    try {\n        GuestArena::GuestArenaCommit_nid_postfix(mapped, DriverMemoryBytes, 0x04u, DriverMemoryBytes);\n    } catch (...) {\n        GuestArena::GuestArenaRelease_nid_postfix(mapped, DriverMemoryBytes);\n        throw;\n    }\n    DriverMemoryAddress = reinterpret_cast<std::uint64_t>(mapped);\n    FsTableAddress = DriverMemoryAddress + 0x40000ull;\n    FsRoutineTableAddress = FsTableAddress + FsTableSlots * FsTableSlotBytes;\n    FsRoutineAddress = FsRoutineTableAddress + FsRoutineTableBytes;\n#else\n    mapped = mmap(reinterpret_cast<void*>(DriverMemoryAddress)',file);
  return replaceOnce(text,'            pthread_attr_t attributes;',
   '#ifdef __APPLE__\n            high = reinterpret_cast<std::uintptr_t>(pthread_get_stackaddr_np(pthread_self()));\n            low = high - pthread_get_stacksize_np(pthread_self());\n#else\n            pthread_attr_t attributes;',file).replace('            pthread_attr_destroy(&attributes);','            pthread_attr_destroy(&attributes);\n#endif');
 });
 edit('core/libs/prx/libSceAgcDriver/Execution/src/GuestMemory.cpp',(text,file)=>replaceOnce(text,'#else\n            pthread_attr_t attributes;',
  '#elif defined(__APPLE__)\n            high = reinterpret_cast<std::uintptr_t>(pthread_get_stackaddr_np(pthread_self()));\n            low = high - pthread_get_stacksize_np(pthread_self());\n#else\n            pthread_attr_t attributes;',file));
 edit('core/libs/prx/libSceAgcDriver/Execution/src/GuestMemory.cpp',(text,file)=>{
  text=replaceOnce(text,'#include <link.h>','#include "prx/libc/include/specifics/linux/ElfTypes.hpp"\n#ifdef __APPLE__\n#include <sys/mman.h>\n#include <mach/mach.h>\n#include <mach/mach_vm.h>\n#endif',file);
  const branch=fs.readFileSync(new URL('./DarwinDescribePages.inc',import.meta.url),'utf8');
  return replaceOnce(text,'#else\n        const auto generation = GuestAllocations::GuestAllocationsGeneration_nid_postfix();',
   '#elif defined(__APPLE__)\n'+branch+'#else\n        const auto generation = GuestAllocations::GuestAllocationsGeneration_nid_postfix();',file);
 });
 edit('core/libs/prx/libSceAgcDriver/Execution/src/FrameRecorder.cpp',(text,file)=>{
  text=replaceOnce(text,'#include <unistd.h>','#include <unistd.h>\n#ifdef __APPLE__\n#include <crt_externs.h>\n#endif',file);
  return replaceOnce(text,'#else\n    char** entries = environ;','#elif defined(__APPLE__)\n    char** entries = *_NSGetEnviron();\n#else\n    char** entries = environ;',file);
 });
 edit('core/libs/prx/libkernel/System/src/Exception.cpp',(text,file)=>{
  text=replaceOnce(text,'#include <ucontext.h>','#ifdef __APPLE__\n#include <sys/ucontext.h>\n#include <mach/i386/thread_status.h>\n#else\n#include <ucontext.h>\n#endif',file);
  const start=text.indexOf('void FromHost(const mcontext_t& host, GuestMcontext& m) {'),end=text.indexOf('\nvoid Deliver(int signum, siginfo_t*, void* context)',start);
  if(start<0||end<0)throw Error('AnyPS5 signal context overlay does not match '+file);
  return text.slice(0,start)+'#ifdef __APPLE__\n'+fs.readFileSync(new URL('./DarwinSignalContext.inc',import.meta.url),'utf8')+'#else\n'+text.slice(start,end)+'#endif\n'+text.slice(end);
 });
 edit('core/libs/prx/libSceAgcDriver/Execution/src/VulkanDevice.cpp',(text,file)=>replaceOnce(text,
  '#ifndef _WIN32\n        state->dmaBufImport =', '#if defined(__linux__)\n        state->dmaBufImport =',file));
 edit('core/libs/prx/libSceAudioIn/CMakeLists.txt',(text,file)=>replaceOnce(text,
  'target_link_options(libSceAudioIn PRIVATE LINKER:--exclude-libs,ALL)',
  'if(NOT APPLE)\n    target_link_options(libSceAudioIn PRIVATE LINKER:--exclude-libs,ALL)\nendif()',file));
 edit('core/Decoder/Jpeg/CMakeLists.txt',(text,file)=>replaceOnce(text,
  '                -DCMAKE_OSX_ARCHITECTURES=${CMAKE_OSX_ARCHITECTURES}',
  '                -DCMAKE_OSX_ARCHITECTURES=${CMAKE_OSX_ARCHITECTURES}\n                -DCMAKE_OSX_DEPLOYMENT_TARGET=${CMAKE_OSX_DEPLOYMENT_TARGET}\n                "-DCMAKE_C_FLAGS=${CMAKE_C_FLAGS}"\n                "-DCMAKE_CXX_FLAGS=${CMAKE_CXX_FLAGS}"',file));
 edit('core/libs/prx/libSceLibreSsl/CMakeLists.txt',(text)=>text+'\nif(APPLE AND CMAKE_CXX_COMPILER_ID MATCHES "Clang")\n    target_compile_options(libSceLibreSsl PRIVATE -fconstexpr-steps=10000000)\nendif()\n');
 return changes;
}
