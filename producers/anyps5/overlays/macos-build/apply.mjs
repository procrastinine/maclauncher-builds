import fs from 'node:fs';
import path from 'node:path';
function replaceOnce(text,before,after,file){
 if(text.indexOf(before)<0||text.indexOf(before)!==text.lastIndexOf(before))throw Error('AnyPS5 macOS build overlay does not match '+file);
 return text.replace(before,after);
}
export function applyBuildOverlay(projectionRoot){
 const changes=[];
 const edit=(relative,adapt)=>{const file=path.join(projectionRoot,relative),before=fs.readFileSync(file,'utf8'),after=adapt(before,relative);if(before!==after){fs.writeFileSync(file,after);changes.push(relative);}};
 edit('3rdparty/libpsl/src/psl-make-dafsa',(text,file)=>replaceOnce(text,
  'bytes(psl_input_file, **codecs)',
  'bytes(os.path.basename(psl_input_file), **codecs)',file));
 edit('core/libs/prx/libc/src/GuestHeap.cpp',(text,file)=>replaceOnce(text,
  '        static ArenaHeap heap;',
  '        // Exit handlers and static destructors can allocate after the first heap use.\n        static auto& heap = *new ArenaHeap;',file));
 edit('core/libs/prx/libSceNpCommon/Runtime.cpp',(text)=>text.replace(/(reinterpret_cast<\w+>)\((\w+->vtable\[\d+\])\)/g,'$1(const_cast<void*>($2))'));
 // Upstream's Darwin page query intersects the Mach protection with the write-watch protection. Read-trapped
 // texture-label pages are host PROT_NONE while still logically readable, and trap changes do not invalidate
 // the page cache, so CheckRange and CopyMapped would report those pages as unmapped. This branch reports the
 // write-watch protection for watched pages.
 edit('core/libs/prx/libSceAgcDriver/Execution/src/GuestMemory.cpp',(text,file)=>{
  const branch=fs.readFileSync(new URL('./DarwinDescribePages.inc',import.meta.url),'utf8');
  return replaceOnce(text,'#else\n        const auto generation = GuestAllocations::GuestAllocationsGeneration_nid_postfix();',
   '#elif defined(__APPLE__)\n'+branch+'#else\n        const auto generation = GuestAllocations::GuestAllocationsGeneration_nid_postfix();',file);
 });
 edit('core/libs/prx/libkernel/System/src/Exception.cpp',(text,file)=>{
  text=replaceOnce(text,'#include <ucontext.h>','#ifdef __APPLE__\n#include <sys/ucontext.h>\n#include <mach/i386/thread_status.h>\n#else\n#include <ucontext.h>\n#endif',file);
  const start=text.indexOf('void FromHost(const mcontext_t& host, GuestMcontext& m) {'),end=text.indexOf('\n#else\nvoid FromHost(const mcontext_t& host, GuestMcontext& m)',start);
  if(start<0||end<0)throw Error('AnyPS5 signal context overlay does not match '+file);
  return text.slice(0,start)+fs.readFileSync(new URL('./DarwinSignalContext.inc',import.meta.url),'utf8')+text.slice(end);
 });
 edit('core/libs/prx/libSceLibcInternal/BasicString.cpp',(text,file)=>replaceOnce(text,
  '    return std::min(count, source->size - position);',
  '    return std::min<std::uint64_t>(count, source->size - position);',file));
 edit('core/libs/prx/libc/src/RunReport.cpp',(text,file)=>replaceOnce(text,
  '#include <system_error>\n', '#include <system_error>\n#include <thread>\n',file));
 edit('core/libs/prx/libSceAgcDriver/Execution/src/VulkanDevice.cpp',(text,file)=>replaceOnce(text,
  '#include <unistd.h>\n#endif\n', '#include <unistd.h>\nextern char** environ;\n#endif\n',file));
 edit('core/libs/prx/libSceAgcDriver/Execution/src/VulkanDevice.cpp',(text,file)=>replaceOnce(text,
  '#ifndef _WIN32\n        state->dmaBufImport =', '#if defined(__linux__)\n        state->dmaBufImport =',file));
 edit('core/libs/prx/libSceAudioOut/src/AudioOut.cpp',(text,file)=>replaceOnce(text,
  '    HostGainRamp hostGain;', '    HostGainRamp hostGain{};',file));
 edit('core/libs/prx/libSceAudioIn/CMakeLists.txt',(text,file)=>replaceOnce(text,
  'target_link_options(libSceAudioIn PRIVATE LINKER:--exclude-libs,ALL)',
  'if(NOT APPLE)\n    target_link_options(libSceAudioIn PRIVATE LINKER:--exclude-libs,ALL)\nendif()',file));
 edit('core/Decoder/Jpeg/CMakeLists.txt',(text,file)=>replaceOnce(text,
  '                -DCMAKE_OSX_ARCHITECTURES=${CMAKE_OSX_ARCHITECTURES}',
  '                -DCMAKE_OSX_ARCHITECTURES=${CMAKE_OSX_ARCHITECTURES}\n                -DCMAKE_OSX_DEPLOYMENT_TARGET=${CMAKE_OSX_DEPLOYMENT_TARGET}\n                "-DCMAKE_C_FLAGS=${CMAKE_C_FLAGS}"\n                "-DCMAKE_CXX_FLAGS=${CMAKE_CXX_FLAGS}"',file));
 edit('core/libs/prx/libcurl/CMakeLists.txt',(text,file)=>replaceOnce(text,
  'ExternalProject_Add(anyps5_curl_build',
  'if(APPLE)\n    list(APPEND curlBackendOptions\n        "-DCMAKE_OSX_ARCHITECTURES:STRING=${CMAKE_OSX_ARCHITECTURES}"\n        "-DCMAKE_OSX_DEPLOYMENT_TARGET:STRING=${CMAKE_OSX_DEPLOYMENT_TARGET}"\n        "-DCMAKE_OSX_SYSROOT:PATH=${CMAKE_OSX_SYSROOT}"\n        "-DCMAKE_C_FLAGS:STRING=${CMAKE_C_FLAGS}")\nendif()\n\nExternalProject_Add(anyps5_curl_build',file));
 edit('core/libs/prx/libcurl/CMakeLists.txt',(text,file)=>replaceOnce(text,
  'elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")\n    set_property(TARGET anyps5_curl_backend APPEND PROPERTY INTERFACE_LINK_LIBRARIES pthread)',
  'elseif(APPLE)\n    set_property(TARGET anyps5_curl_backend APPEND PROPERTY INTERFACE_LINK_LIBRARIES "-framework CoreFoundation" "-framework SystemConfiguration")\nelseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")\n    set_property(TARGET anyps5_curl_backend APPEND PROPERTY INTERFACE_LINK_LIBRARIES pthread)',file));
 edit('core/libs/prx/libSceLibreSsl/CMakeLists.txt',(text)=>text+'\nif(APPLE AND CMAKE_CXX_COMPILER_ID MATCHES "Clang")\n    target_compile_options(libSceLibreSsl PRIVATE -fconstexpr-steps=10000000)\nendif()\n');
 return changes;
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * heap lifetime through late exit allocation:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/0861f8dac1bd2c6e28aea52b29cfac81f6e5e2f9
 */
