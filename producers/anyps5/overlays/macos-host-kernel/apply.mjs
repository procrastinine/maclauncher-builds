// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

function replace(source,before,after,file){
 if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('AnyPS5 Darwin host boundary changed: '+file);
 return source.replace(before,after);
}
export function applyHostKernelOverlay(root){
 const changes=[];
 const edit=(relative,adapt)=>{const file=path.join(root,'core/libs',relative);const before=fs.readFileSync(file,'utf8');const after=adapt(before,relative);fs.writeFileSync(file,after);changes.push(relative);};
 edit('prx/libkernel/System/src/Process.cpp',(source,file)=>{
  source='#ifdef __APPLE__\n#include <crt_externs.h>\n#endif\n'+source;
  source=replace(source,'#else\n        std::ifstream stream("/proc/self/cmdline", std::ios::binary);',`#elif defined(__APPLE__)
        const auto count = ::_NSGetArgc();
        const auto values = ::_NSGetArgv();
        if (!count || !values || !*values || *count <= 0)
            throw std::runtime_error("Cannot read process arguments");
        for (int index = 0; index < *count; ++index) {
            if ((*values)[index] == nullptr) throw std::runtime_error("Invalid process argument vector");
            arguments.emplace_back((*values)[index]);
        }
#else
        std::ifstream stream("/proc/self/cmdline", std::ios::binary);`,file);
  return source;
 });
 edit('prx/libSceLibcInternal/Spawn.cpp',(source,file)=>{
  source='#ifdef __APPLE__\n#include "prx/libc/include/HostErrno.hpp"\n#endif\n'+source;
  return replace(source,'        result = posix_spawn(&childPid, target.c_str(), usedActions, usedAttributes, arguments, hostEnvironment);',
   '        result = posix_spawn(&childPid, target.c_str(), usedActions, usedAttributes, arguments, hostEnvironment);\n#ifdef __APPLE__\n        if (result != 0) result = GuestErrnoFromHost_nid_no_patch(result);\n#endif',file);
 });
 edit('prx/libc/src/HostErrno.cpp',(source,file)=>{
  source=replace(source,'extern "C" int GuestErrnoFromHost_nid_no_patch(int error) {',`extern "C" int GuestErrnoFromHost_nid_no_patch(int error) {
#ifdef __APPLE__
    // Darwin and the guest share the original BSD errno values through 81.
    if (error > 0 && error <= 81) return error;
    switch (error) {
        case EOVERFLOW: return GuestEoverflow;
        case EBADEXEC: case EBADARCH: case ESHLIBVERS: case EBADMACHO: return 8;
        case ECANCELED: return 85;
        case EIDRM: return 82;
        case ENOMSG: return 83;
        case EILSEQ: return 86;
        case ENOATTR: return 87;
        case EBADMSG: return 89;
        case EMULTIHOP: return 90;
        case ENOLINK: return 91;
        case EPROTO: return 92;
        case EOPNOTSUPP: return 45;
        case ENOTCAPABLE: return 93;
        case ENOTRECOVERABLE: return 95;
        case EOWNERDEAD: return 96;
        default: return GuestEio;
    }
#else`,file);
  return replace(source,'    return error > 0 && error <= 34 ? error : GuestEio;\n}','    return error > 0 && error <= 34 ? error : GuestEio;\n#endif\n}',file);
 });
 for(const relative of ['prx/libkernel/File/src/Open.cpp','prx/libkernel/File/src/Stdio.cpp'])edit(relative,(source,file)=>{
  source='#ifdef __APPLE__\n#include "prx/libc/include/HostErrno.hpp"\n#endif\n'+source;
  const marker='static int SceErrorFromErrno(int error) {';
  const start=source.indexOf(marker),end=source.indexOf('\n}',start);
  if(start<0||end<0||source.indexOf(marker,start+1)>=0)throw Error('AnyPS5 Darwin errno boundary changed: '+file);
  return source.slice(0,start)+marker+'\n#ifdef __APPLE__\n    return SceKernelError(GuestErrnoFromHost_nid_no_patch(error));\n#else'+source.slice(start+marker.length,end)+'\n#endif'+source.slice(end);
 });
 edit('prx/libkernel/Socket/src/Socket.cpp',(source,file)=>{
  source='#ifdef __APPLE__\n#include <sys/select.h>\n#endif\n'+source;
  source=replace(source,'int HostPoll(KernelSocketPoll::Entry* descriptors, int count, int timeoutMilliseconds) {\n    std::vector<struct pollfd>',`int HostPoll(KernelSocketPoll::Entry* descriptors, int count, int timeoutMilliseconds) {
#ifdef __APPLE__
    if (count < 0) return -GuestEinval;
    if (count > 0 && descriptors == nullptr) return -EFAULT;
    fd_set reads, writes, urgent;
    FD_ZERO(&reads); FD_ZERO(&writes); FD_ZERO(&urgent);
    int highest = -1;
    for (int index = 0; index < count; ++index) {
        const auto& entry = descriptors[index];
        if (entry.descriptor < 0 || entry.descriptor >= FD_SETSIZE) return -GuestEinval;
        if (entry.events & KernelSocketPoll::Readable) FD_SET(entry.descriptor, &reads);
        if (entry.events & KernelSocketPoll::Writable) FD_SET(entry.descriptor, &writes);
        if (entry.events & KernelSocketPoll::Urgent) FD_SET(entry.descriptor, &urgent);
        highest = std::max(highest, entry.descriptor);
    }
    timeval timeout{timeoutMilliseconds < 0 ? 0 : timeoutMilliseconds / 1000,
                    timeoutMilliseconds < 0 ? 0 : (timeoutMilliseconds % 1000) * 1000};
    // Native select supports valid character devices which Darwin poll rejects.
    const int result = ::select(highest + 1, &reads, &writes, &urgent,
                                timeoutMilliseconds < 0 ? nullptr : &timeout);
    if (result < 0) return -errno;
    for (int index = 0; index < count; ++index) {
        auto& entry = descriptors[index];
        entry.revents = static_cast<short>((FD_ISSET(entry.descriptor, &reads) ? KernelSocketPoll::Readable : 0) |
            (FD_ISSET(entry.descriptor, &writes) ? KernelSocketPoll::Writable : 0) |
            (FD_ISSET(entry.descriptor, &urgent) ? KernelSocketPoll::Urgent : 0));
    }
    return result;
#else
    std::vector<struct pollfd>`,file);
  return replace(source,'    return result;\n}\n\n#else\n\nint HostPoll','    return result;\n#endif\n}\n\n#else\n\nint HostPoll',file);
 });
 edit('prx/libkernel/Socket/include/SocketError.hpp',(source,file)=>replace(source,'        case EOPNOTSUPP: return 45;',`        case EOPNOTSUPP: return 45;
#if ENOTSUP != EOPNOTSUPP
        case ENOTSUP: return 45;
#endif`,file));
 edit('prx/libc/src/HeapDiagnostics.cpp',(source,file)=>{
  source='#ifdef __APPLE__\n#include <pthread.h>\n#endif\n'+source;
  return replace(source,'#else\n    return static_cast<unsigned long>(::syscall(SYS_gettid));',`#elif defined(__APPLE__)
    std::uint64_t id = 0;
    if (::pthread_threadid_np(nullptr, &id) != 0) throw std::runtime_error("Cannot read the host thread identifier");
    return static_cast<unsigned long>(id);
#else
    return static_cast<unsigned long>(::syscall(SYS_gettid));`,file);
 });
 // Keep the native SA_SIGINFO watch installed; publish guest handlers atomically.
 edit('prx/libc/include/GuestWriteWatch.hpp',(source,file)=>replace(source,
  'bool GuestWriteWatchAvailable_nid_postfix();',
  'bool GuestWriteWatchAvailable_nid_postfix();\n#ifdef __APPLE__\nbool GuestWriteWatchChainSignal_nid_no_patch(int signal, void (*handler)(int));\n#endif',file));
 edit('prx/libc/src/GuestWriteWatch.cpp',(source,file)=>{
  const apple=source.indexOf('#elif defined(__APPLE__)\nclass Watch {');
  const method=source.indexOf('    void Register(std::uintptr_t begin, std::uintptr_t end) {',apple);
  if(method<apple)throw Error('AnyPS5 Darwin write-watch class changed');
  source=source.slice(0,method)+
   '    bool ChainSignal(int signal, void (*handler)(int)) {\n        if (!_available || (signal != SIGBUS && signal != SIGSEGV)) return false;\n        (signal == SIGBUS ? _guestBus : _guestSegv).store(handler, std::memory_order_release);\n        return true;\n    }\n\n'+source.slice(method);
  source=replace(source,'        const auto& previous = signal == SIGBUS ? watch._previousBus : watch._previousSegv;',
   '        const auto chained = (signal == SIGBUS ? watch._guestBus : watch._guestSegv).load(std::memory_order_acquire);\n        if (chained != SIG_ERR) {\n            if (chained == SIG_IGN) return;\n            if (chained != SIG_DFL && chained != nullptr) { chained(signal); return; }\n            ::signal(signal, SIG_DFL);\n            return;\n        }\n        const auto& previous = signal == SIGBUS ? watch._previousBus : watch._previousSegv;',file);
  source=replace(source,'    struct sigaction _previousBus {};',
   '    using HostHandler = void (*)(int);\n    static_assert(std::atomic<HostHandler>::is_always_lock_free);\n    std::atomic<HostHandler> _guestBus{SIG_ERR};\n    std::atomic<HostHandler> _guestSegv{SIG_ERR};\n    struct sigaction _previousBus {};',file);
  return replace(source,'bool GuestWriteWatchAvailable_nid_postfix() {',
   '#ifdef __APPLE__\nbool GuestWriteWatchChainSignal_nid_no_patch(int signal, void (*handler)(int)) {\n    return Watch::Get().ChainSignal(signal, handler);\n}\n#endif\n\nbool GuestWriteWatchAvailable_nid_postfix() {',file);
 });
 edit('prx/libkernel/System/src/Signals.cpp',(source,file)=>{
  source=replace(source,'#include <new>','#include <new>\n#include <pthread/qos.h>',file);
  source=replace(source,'void RunAlarms() {','void RunAlarms() {\n#ifdef __APPLE__\n    pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);\n#endif',file);
  source='#ifdef __APPLE__\n#include "prx/libc/include/GuestWriteWatch.hpp"\n#endif\n'+source;
  source=replace(source,'void ResetToDefault(int guest) {',
   'bool InstallHostHandler(int native, void (*handler)(int)) {\n#ifdef __APPLE__\n    if (GuestWriteWatch::GuestWriteWatchChainSignal_nid_no_patch(native, handler)) return true;\n#endif\n    return std::signal(native, handler) != SIG_ERR;\n}\nvoid ResetToDefault(int guest) {',file);
  source=replace(source,'    if (const int native = NativeSignal(guest)) std::signal(native, SIG_DFL);',
   '    if (const int native = NativeSignal(guest)) (void)InstallHostHandler(native, SIG_DFL);',file);
  return replace(source,'    if (std::signal(native, hostHandler) == SIG_ERR) {',
   '    if (!InstallHostHandler(native, hostHandler)) {',file);
 });
 edit('prx/libkernel/Time/Time.cpp',(source,file)=>{
  source='#ifdef __APPLE__\n#include <pthread.h>\n#endif\n'+source;
  return replace(source,'    return static_cast<unsigned long>(gettid());\n#else\n    return 0;',`    return static_cast<unsigned long>(gettid());
#elif defined(__APPLE__)
    std::uint64_t id = 0;
    if (::pthread_threadid_np(nullptr, &id) != 0) throw std::runtime_error("Cannot read the host thread identifier");
    return static_cast<unsigned long>(id);
#else
    return 0;`,file);
 });
 edit('prx/libc/include/CpuTopology.hpp',(source,file)=>{
  source=replace(source,'#elif defined(__linux__)\n#include <fstream>','#elif defined(__APPLE__)\n#include <pthread.h>\n#elif defined(__linux__)\n#include <fstream>',file);
  return replace(source,'    return handle == nullptr ? static_cast<unsigned long>(gettid()) : 0;\n#else',`    return handle == nullptr ? static_cast<unsigned long>(gettid()) : 0;
#elif defined(__APPLE__)
    std::uint64_t id = 0;
    if (::pthread_threadid_np(reinterpret_cast<pthread_t>(handle), &id) != 0) return 0;
    return static_cast<unsigned long>(id);
#else`,file);
 });

 return changes;
}
