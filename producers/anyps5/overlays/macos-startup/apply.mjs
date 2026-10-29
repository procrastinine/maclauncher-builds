import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source,before,after) {
 if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('AnyPS5 Darwin startup boundary changed: '+before.slice(0,90));
 return source.replace(before,after);
}
export async function applyStartupOverlay(root) {
 const edit=async(relative,transform)=>{const file=path.join(root,relative);await fs.writeFile(file,transform(await fs.readFile(file,'utf8')));};
 await edit('CMakeLists.txt',source=>replace(source,'project(Relinker CXX)','project(Relinker CXX)\nif(APPLE)\n    enable_language(ASM)\nendif()'));
 const base=path.join(root,'core/libs/prx/libkernel/Pthread/src');
 for(const name of ['GuestStartup.S','GuestTlsLifecycle.inc','GuestMainLifecycle.inc'])await fs.copyFile(new URL('./'+name,import.meta.url),path.join(base,name));
 await edit('core/libs/prx/libkernel/CMakeLists.txt',source=>replace(source,'        ${CMAKE_CURRENT_SOURCE_DIR}/Pthread/src/GuestTlsMacOs.cpp','        ${CMAKE_CURRENT_SOURCE_DIR}/Pthread/src/GuestTlsMacOs.cpp\n        ${CMAKE_CURRENT_SOURCE_DIR}/Pthread/src/GuestStartup.S'));
 await edit('core/libs/prx/libkernel/Pthread/src/GuestTlsMacOs.cpp',source=>{
  source=replace(source,'#include <pthread.h>','#include <pthread.h>\n#include <atomic>\n#include <cpuid.h>\n#include <dlfcn.h>\n#include <limits>\n#include <map>\n#include <mutex>\n#include <vector>\n#include <mach-o/dyld.h>');
  source=replace(source,'void Release(void* threadPointer) {\n    std::free(*reinterpret_cast<void**>(static_cast<std::uint8_t*>(threadPointer) + AllocationSlot));\n}', '#include "GuestTlsLifecycle.inc"\n\nvoid Release(void* threadPointer) {\n    ReleaseBlock(threadPointer);\n}');
  source=replace(source,`std::uint8_t Aps5GuestTlsAvx_nid_no_patch = [] {
    __builtin_cpu_init();
    return __builtin_cpu_supports("avx") ? 1 : 0;
}();`,'GuestVectorState Aps5GuestVectorState_nid_no_patch = VectorState();');
  const start=source.indexOf('    if (descriptor == nullptr',source.indexOf('void Aps5GuestTlsRegister_nid_no_patch(')),end=source.indexOf('\n}',start);
  if(start<0||end<0)throw Error('Darwin TLS registration boundary changed');
  source=source.slice(0,start)+'    RegisterTlsKey(descriptor);'+source.slice(end);
  source=replace(source,'    void* base = nullptr;',`    const auto key = RegisterTlsKey(const_cast<GuestTlsDescriptor*>(descriptor));
    if (auto* existing = pthread_getspecific(key)) return existing;
    void* base = nullptr;`);
  source=replace(source,'    if (pthread_setspecific(static_cast<pthread_key_t>(descriptor->key), threadPointer) != 0) Fail("cannot store the thread pointer");','    RecordTlsAllocation(descriptor,threadPointer);\n    if (pthread_setspecific(key, threadPointer) != 0) { ReleaseBlock(threadPointer); Fail("cannot store the thread pointer"); }');
  source=replace(source,'    const auto* descriptor = index->module;','    if (!index) Fail("null TLS index");\n    const auto* descriptor = index->module;\n    ValidateDescriptor(descriptor);\n    if (index->offset > descriptor->blockSize) Fail("TLS offset exceeds its block");');
  const assembly=source.indexOf('\nasm(R"('),finish=source.indexOf('\n)");',assembly);
  if(assembly<0||finish<assembly)throw Error('Darwin TLS call-state boundary changed');
  return source.slice(0,assembly)+source.slice(finish+5);
 });
 await edit('core/libs/prx/libkernel/Pthread/src/MainThreadMacOs.cpp',source=>{
  source=replace(source,'#include <cstdlib>','#include <cstdlib>\n#include <cstring>\n#include <exception>\n#include <stdexcept>\n#include <vector>\n#include <mach-o/dyld.h>\n#include <mach-o/getsect.h>\n#include <mach-o/loader.h>');
  source=replace(source,'struct GuestStart {','#include "GuestMainLifecycle.inc"\n\nstruct GuestStart {');
  source=replace(source,'    start.entry(start.block, nullptr);\n    std::fprintf(stderr, "guest entry returned\\n");\n    std::abort();','    guestMainThread = true;\n    const int result = Aps5CallGuestProcessEntry_nid_no_patch(reinterpret_cast<void*>(start.entry),start.block,FinalizeGuestImages);\n    FinalizeGuestImages();\n    LibcExit_nid_no_patch(result);');
  source=replace(source,'[[noreturn]] void Aps5StartGuest_nid_no_patch(', 'bool Aps5IsGuestMainThread_nid_no_patch() { return guestMainThread; }\n\n[[noreturn]] void Aps5StartGuest_nid_no_patch(');
  source=replace(source,'    if (pthread_main_np() != 0 || !mainLoopRunning.load(std::memory_order_acquire)) {','    if (!function) throw std::invalid_argument("Darwin main-thread callback is null");\n    if (pthread_main_np() != 0) {');
  return replace(source,'    dispatch_sync_f(dispatch_get_main_queue(), context, function);','    if (!mainLoopRunning.load(std::memory_order_acquire)) throw std::runtime_error("Darwin main-thread service is unavailable");\n    MainInvocation invocation{function,context,nullptr};\n    dispatch_sync_f(dispatch_get_main_queue(), &invocation, InvokeMain);\n    if (invocation.error) std::rethrow_exception(invocation.error);');
 });
 await edit('core/libs/prx/libkernel/Module/src/Tls.cpp',source=>{
  source=replace(source,'extern "C" {','extern "C" {\n#ifdef __APPLE__\nvoid* Aps5GuestTlsGetAddr_nid_no_patch(const KernelTlsIndex*);\n#endif');
  return replace(source,'#elif defined(__linux__)\n    KernelTlsIndex host = *index;','#elif defined(__APPLE__)\n    return Aps5GuestTlsGetAddr_nid_no_patch(index);\n#elif defined(__linux__)\n    KernelTlsIndex host = *index;');
 });
}
