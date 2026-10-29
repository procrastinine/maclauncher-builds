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
  source='#ifdef __APPLE__\n#include <crt_externs.h>\n#include <mach-o/dyld.h>\n#endif\n'+source;
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
  return replace(source,'#else\n    std::error_code error;\n    const auto own = std::filesystem::read_symlink("/proc/self/exe", error);',`#elif defined(__APPLE__)
    std::uint32_t bytes = 0;
    if (::_NSGetExecutablePath(nullptr, &bytes) != -1 || bytes == 0)
        throw std::runtime_error("exec: cannot read the executable path size");
    std::vector<char> nativePath(bytes);
    if (::_NSGetExecutablePath(nativePath.data(), &bytes) != 0)
        throw std::runtime_error("exec: cannot read the executable path");
    return std::filesystem::canonical(std::filesystem::path(nativePath.data()));
#else
    std::error_code error;
    const auto own = std::filesystem::read_symlink("/proc/self/exe", error);`,file);
 });
 edit('prx/libkernel/System/src/Process.cpp',(source,file)=>{
  source=replace(source,'        switch (hostSignal) {','#ifndef __APPLE__\n        switch (hostSignal) {',file);
  return replace(source,'        default: break;\n        }\n        encoded = WIFSTOPPED','        default: break;\n        }\n#endif\n        encoded = WIFSTOPPED',file);
 });
 edit('prx/libSceLibcInternal/Spawn.cpp',(source,file)=>{
  source='#ifdef __APPLE__\n#include "prx/libc/include/HostErrno.hpp"\n#endif\n'+source;
  return replace(source,'        result = posix_spawn(&childPid, target.c_str(), usedActions, usedAttributes, arguments, hostEnvironment);',
   '        result = posix_spawn(&childPid, target.c_str(), usedActions, usedAttributes, arguments, hostEnvironment);\n#ifdef __APPLE__\n        if (result != 0) result = GuestErrnoFromHost_nid_no_patch(result);\n#endif',file);
 });
 edit('prx/libkernel/DirectMemory/Export.cpp',(source,file)=>{
  source='#ifdef __APPLE__\n#include "prx/libc/include/specifics/macos/VirtualMemory.hpp"\n#endif\n'+source;
  return replace(source,' #else\n std::ifstream maps("/proc/self/maps");',` #elif defined(__APPLE__)
 mach_vm_address_t begin = 0;
 mach_vm_size_t size = 0;
 vm_region_submap_info_data_64_t host{};
 if (!DarwinVirtualMemory::Region(address, begin, size, host) || (host.protection & VM_PROT_READ) == 0 ||
     size > std::numeric_limits<uintptr_t>::max() - begin) return SCE_KERNEL_ERROR_EACCES;
 info->start = static_cast<uintptr_t>(begin);
 info->end = static_cast<uintptr_t>(begin + size);
 const bool writable = (host.protection & VM_PROT_WRITE) != 0;
 const bool executable = (host.protection & VM_PROT_EXECUTE) != 0;
 #else
 std::ifstream maps("/proc/self/maps");`,file);
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
 edit('prx/libkernel/Socket/src/Udp.cpp',(source,file)=>replace(source,
  '#else\n    sockaddr unspecified{};\n    unspecified.sa_family = AF_UNSPEC;\n    if (::connect(socket.value, &unspecified, sizeof(unspecified)) != 0) return Fail(NativeError());',
  `#elif defined(__APPLE__)
    sockaddr_storage unspecified{};
    unspecified.ss_family = AF_UNSPEC;
    unspecified.ss_len = static_cast<std::uint8_t>(localSize);
    if (::connect(socket.value, reinterpret_cast<sockaddr*>(&unspecified), localSize) != 0) {
        const int error = NativeError();
        if (error != 47) return Fail(error);
        // Darwin reports EAFNOSUPPORT after disconnecting. Verify that side effect.
        sockaddr_storage remaining{};
        socklen_t remainingSize = sizeof(remaining);
        if (::getpeername(socket.value, reinterpret_cast<sockaddr*>(&remaining), &remainingSize) == 0) return Fail(error);
        if (errno != ENOTCONN) return Fail(NativeError());
    }
#else
    sockaddr unspecified{};
    unspecified.sa_family = AF_UNSPEC;
    if (::connect(socket.value, &unspecified, sizeof(unspecified)) != 0) return Fail(NativeError());`,file));
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
 // The Darwin watch/guest-handler boundary is also used by
 // https://github.com/AnyTogether/AnyPS5-ARM at 61c1c59a4ba7add23da7234b3b482a6d4405a741.
 // Keep the native SA_SIGINFO watch installed; publish guest handlers atomically.
 edit('prx/libc/include/GuestWriteWatch.hpp',(source,file)=>replace(source,
  'bool GuestWriteWatchAvailable_nid_postfix();',
  'bool GuestWriteWatchAvailable_nid_postfix();\n#ifdef __APPLE__\nbool GuestWriteWatchChainSignal_nid_no_patch(int signal, void (*handler)(int));\n#endif',file));
 edit('prx/libc/src/GuestWriteWatch.cpp',(source,file)=>{
  source=replace(source,'#elif defined(__APPLE__)\nclass Watch {',
   '#elif defined(__APPLE__)\nclass Watch {',file);
  const apple=source.indexOf('#elif defined(__APPLE__)\nclass Watch {');
  const method=source.indexOf('    void Register(std::uintptr_t begin, std::uintptr_t end) {',apple);
  if(method<apple)throw Error('AnyPS5 Darwin write-watch class changed');
  source=source.slice(0,method)+
   '    bool ChainSignal(int signal, void (*handler)(int)) {\n        if (!_available || (signal != SIGBUS && signal != SIGSEGV)) return false;\n        (signal == SIGBUS ? _guestBus : _guestSegv).store(handler, std::memory_order_release);\n        return true;\n    }\n\n'+source.slice(method);
  source=replace(source,'        if (watch.record(reinterpret_cast<std::uintptr_t>(info->si_addr))) return;',
   '        const bool protectionFault = info != nullptr &&\n            ((signal == SIGSEGV && info->si_code == SEGV_ACCERR) ||\n             (signal == SIGBUS && info->si_code == BUS_ADRERR));\n        if (protectionFault && watch.record(reinterpret_cast<std::uintptr_t>(info->si_addr))) return;',file);
  source=replace(source,'        const auto& previous = signal == SIGBUS ? watch._previousBus : watch._previousSegv;',
   '        const auto chained = (signal == SIGBUS ? watch._guestBus : watch._guestSegv).load(std::memory_order_acquire);\n        if (chained != SIG_ERR) {\n            if (chained == SIG_IGN) return;\n            if (chained != SIG_DFL && chained != nullptr) { chained(signal); return; }\n            ::signal(signal, SIG_DFL);\n            return;\n        }\n        const auto& previous = signal == SIGBUS ? watch._previousBus : watch._previousSegv;',file);
  source=replace(source,'    struct sigaction _previousBus {};',
   '    using HostHandler = void (*)(int);\n    static_assert(std::atomic<HostHandler>::is_always_lock_free);\n    std::atomic<HostHandler> _guestBus{SIG_ERR};\n    std::atomic<HostHandler> _guestSegv{SIG_ERR};\n    struct sigaction _previousBus {};',file);
  return replace(source,'bool GuestWriteWatchAvailable_nid_postfix() {',
   '#ifdef __APPLE__\nbool GuestWriteWatchChainSignal_nid_no_patch(int signal, void (*handler)(int)) {\n    return Watch::Get().ChainSignal(signal, handler);\n}\n#endif\n\nbool GuestWriteWatchAvailable_nid_postfix() {',file);
 });
 edit('prx/libkernel/System/src/Signals.cpp',(source,file)=>{
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
 edit('prx/libc/src/Interfaces.cpp',(source,file)=>{
  source=replace(source,'#include <netpacket/packet.h>\n#endif','#include <netpacket/packet.h>\n#elif defined(__APPLE__)\n#include <net/if_dl.h>\n#include <net/if_types.h>\n#include "prx/libc/include/specifics/macos/NetworkInterfaces.hpp"\n#endif',file);
  source=replace(source,'#ifdef __linux__\nconstexpr std::uint8_t guestLinkFamily','#if defined(__linux__) || defined(__APPLE__)\nconstexpr std::uint8_t guestLinkFamily',file);
  source=replace(source,'#ifdef __linux__\ntemplate<typename TValue>','#if defined(__linux__) || defined(__APPLE__)\ntemplate<typename TValue>',file);
  source=replace(source,'std::optional<std::uint64_t> ReadSysfsCounter','#endif\n\n#ifdef __linux__\nstd::optional<std::uint64_t> ReadSysfsCounter',file);
  const darwin=fs.readFileSync(new URL('./DarwinInterfaces.inc',import.meta.url),'utf8');
  source=replace(source,'std::uint32_t InterfaceFlags(unsigned int host) {','#ifdef __APPLE__\n'+darwin+'\n#endif\n\nstd::uint32_t InterfaceFlags(unsigned int host) {',file);
  source=replace(source,'    try {\n        for (auto* item = host; item; item = item->ifa_next) {','    try {\n#ifdef __APPLE__\n        const auto statistics = DarwinNetworkInterfaces::Statistics();\n#endif\n        for (auto* item = host; item; item = item->ifa_next) {',file);
  return replace(source,'#endif\n            if (item->ifa_addr->sa_family != AF_INET && item->ifa_addr->sa_family != AF_INET6) continue;',`#elif defined(__APPLE__)
            if (item->ifa_addr->sa_family == AF_LINK) {
                const auto& link = *reinterpret_cast<const sockaddr_dl*>(item->ifa_addr);
                HostInterface& owner = interfaceFor(CheckedName(item->ifa_name));
                if (owner.linked) throw std::runtime_error("getifaddrs: two link-level entries for " + owner.name);
                if (link.sdl_index == 0 || link.sdl_len < offsetof(sockaddr_dl, sdl_data) + link.sdl_nlen + link.sdl_alen)
                    throw std::runtime_error("getifaddrs: invalid link-level address on " + owner.name);
                const auto found = std::find_if(statistics.begin(), statistics.end(), [&](const if_msghdr2& row) { return row.ifm_index == link.sdl_index; });
                if (found == statistics.end()) throw std::runtime_error("getifaddrs: no interface statistics for " + owner.name);
                const std::uint8_t type = link.sdl_type == IFT_ETHER ? guestTypeEthernet : link.sdl_type == IFT_LOOP ? guestTypeLoopback
                    : link.sdl_type == IFT_PPP ? guestTypePpp : guestTypeOther;
                const std::uint8_t hardwareLength = type == guestTypeLoopback ? 0 : link.sdl_alen;
                const auto* hardware = reinterpret_cast<const std::uint8_t*>(&link) + offsetof(sockaddr_dl, sdl_data) + link.sdl_nlen;
                owner.link = Entry{owner.name, InterfaceFlags(item->ifa_flags),
                    GuestLinkAddress(owner.name, link.sdl_index, type, hardware, hardwareLength), {}, {},
                    GuestDarwinInterfaceData(*found, type, hardwareLength)};
                owner.linked = true;
                continue;
            }
#endif
            if (item->ifa_addr->sa_family != AF_INET && item->ifa_addr->sa_family != AF_INET6) continue;`,file);
 });
 return changes;
}
