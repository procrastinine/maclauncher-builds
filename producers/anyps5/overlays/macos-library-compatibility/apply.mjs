// SPDX-License-Identifier: GPL-2.0-only
import {edit} from '../macos-aborts/apply.mjs';
export function applyLibraryCompatibilityOverlay(root) {
  edit(root, `core/relinker/elfpatcher/src/macos/MacOsImage.cpp`, [
    [`        Io::AppendU32(commands, segment.Protection);
        Io::AppendU32(commands, segment.Protection);`, `#ifdef __APPLE__
        Io::AppendU32(commands, segment.Name.starts_with("__ELF") ? VmProtRead | VmProtWrite | VmProtExecute : segment.Protection);
#else
        Io::AppendU32(commands, segment.Protection);
#endif
        Io::AppendU32(commands, segment.Protection);`]
  ]);
  edit(root, `core/libs/prx/libc/src/GuestAllocations.cpp`, [
    [`                if (segment.vmsize != 0 && segment.initprot != VM_PROT_NONE)`, `                if (segment.vmsize != 0 && (segment.initprot != VM_PROT_NONE || std::strncmp(segment.segname, "__ELF", 5) == 0))`]
  ]);
  edit(root, `core/libs/prx/libkernel/Time/Time.cpp`, [
    [`static int ReadClock(int clockId, KernelTimespec* tp) {`, `#ifdef __APPLE__
static std::uint64_t MachThreadCpuNanos() {
    thread_basic_info_data_t info{};
    mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
    if (thread_info(pthread_mach_thread_np(pthread_self()), THREAD_BASIC_INFO, reinterpret_cast<thread_info_t>(&info), &count) != KERN_SUCCESS)
        throw std::runtime_error("clock_gettime: thread_info failed");
    const auto micros = (static_cast<std::uint64_t>(info.user_time.seconds) + static_cast<std::uint64_t>(info.system_time.seconds)) * 1000000ULL +
                        static_cast<std::uint64_t>(info.user_time.microseconds) + static_cast<std::uint64_t>(info.system_time.microseconds);
    return micros * 1000ULL;
}
#endif

static int ReadClock(int clockId, KernelTimespec* tp) {
#ifdef __APPLE__
    if (clockId == GUEST_CLOCK_THREAD_CPUTIME_ID) {
        const auto nanos = MachThreadCpuNanos();
        tp->tv_sec = static_cast<std::int64_t>(nanos / 1000000000ULL);
        tp->tv_nsec = static_cast<std::int64_t>(nanos % 1000000000ULL);
        return 0;
    }
#endif`],
    [`#include "prx/libkernel/Time/include/Time.hpp"`, `#include "prx/libkernel/Time/include/Time.hpp"
#ifdef __APPLE__
#include <mach/mach.h>
#include <pthread.h>
#endif`],
    [`    if (res == nullptr) return 0;`, `    if (res == nullptr) return 0;
#ifdef __APPLE__
    if (clockId == GUEST_CLOCK_THREAD_CPUTIME_ID) {
        res->tv_sec = 0;
        res->tv_nsec = 1000;
        return 0;
    }
#endif`]
  ]);
  edit(root, `core/libs/prx/libSceFontFt/Export.cpp`, [
    [`int APS5_VABI sceFontFtSupportSystemFonts(FontLibrary library) {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}`, `#ifdef __APPLE__
int APS5_VABI sceFontFtSupportSystemFonts(FontLibrary library) {
    return FontFt::SupportFormats(library, {"truetype", "cff"});
}
#else
int APS5_VABI sceFontFtSupportSystemFonts(FontLibrary library) {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}
#endif`]
  ]);
  edit(root, `core/libs/prx/libSceVoice/Export.cpp`, [
    [`int APS5_VABI sceVoiceWriteToIPort(uint32_t input_port_id, const void* data, uint32_t* size, int16_t frame_gaps) {
    (void)input_port_id;
    (void)data;
    (void)size;
    (void)frame_gaps;
    NotImplemented_nid_no_patch(__func__);
    return 0;
}`, `#ifdef __APPLE__
int APS5_VABI sceVoiceWriteToIPort(uint32_t input_port_id, const void* data, uint32_t* size, int16_t frame_gaps) {
    (void)frame_gaps;
    auto& voice = State();
    std::lock_guard lock(voice.mutex);
    if (!voice.initialized) return NotInitialized;
    if (data == nullptr || size == nullptr) return InvalidArgument;
    const auto found = voice.ports.find(input_port_id);
    if (found == voice.ports.end()) return PortNotFound;
    const auto type = found->second.type;
    if (type != PortInPcm && type != PortInVoice) return InvalidArgument;
    return 0;
}
#else
int APS5_VABI sceVoiceWriteToIPort(uint32_t input_port_id, const void* data, uint32_t* size, int16_t frame_gaps) {
    (void)input_port_id;
    (void)data;
    (void)size;
    (void)frame_gaps;
    NotImplemented_nid_no_patch(__func__);
    return 0;
}
#endif`]
  ]);
  edit(root, `core/libs/prx/libc/Export.cpp`, [
    [`#include <cstdint>`, `#include <cstdint>
#ifdef __APPLE__
#include <cstdio>
#include <cstdlib>
#endif`],
    [`int APS5_VABI _ZSt14_Atomic_assertPKcS0__nid_postfix() {
 NotImplemented_nid_no_patch(__func__);
 return 0;
}`, `#ifdef __APPLE__
[[noreturn]] void APS5_VABI _ZSt14_Atomic_assertPKcS0__nid_postfix(const char* expression, const char* location) {
    std::fprintf(stderr, "[libc] guest atomic assertion failed: %s (%s)\\n", expression ? expression : "?", location ? location : "?");
    std::fflush(stderr);
    std::abort();
}
#else
int APS5_VABI _ZSt14_Atomic_assertPKcS0__nid_postfix() {
 NotImplemented_nid_no_patch(__func__);
 return 0;
}
#endif`]
  ]);
  edit(root, `core/libs/prx/libc/include/Api.hpp`, [
    [`int APS5_VABI _ZSt14_Atomic_assertPKcS0__nid_postfix();`, `#ifdef __APPLE__
[[noreturn]] void APS5_VABI _ZSt14_Atomic_assertPKcS0__nid_postfix(const char* expression, const char* location);
#else
int APS5_VABI _ZSt14_Atomic_assertPKcS0__nid_postfix();
#endif`]
  ]);
  edit(root, `core/libs/prx/libc/src/exception/TypeInfo.cpp`, [
    [`static_assert(sizeof(TypeInfoVtable) == 11 * sizeof(void*));`, `static_assert(sizeof(TypeInfoVtable) == 11 * sizeof(void*));
#ifdef __APPLE__
bool APS5_VABI UpcastNonclassTypeInfo(const std::type_info*, const ClassTypeInfo*, void**) { return false; }
struct FunctionTypeInfoVtable {
    std::ptrdiff_t offset;
    const std::type_info* type;
    decltype(&DestroyTypeInfo) destroy = DestroyTypeInfo;
    decltype(&DeleteTypeInfo) deleteObject = DeleteTypeInfo;
    decltype(&IsPointerTypeInfo) isPointer = IsPointerTypeInfo;
    decltype(&IsFunctionTypeInfoTrue) isFunction = IsFunctionTypeInfoTrue;
    decltype(&CatchTypeInfo) catchType = CatchTypeInfo;
    decltype(&UpcastNonclassTypeInfo) upcast = UpcastNonclassTypeInfo;
};
struct PointerTypeInfoVtable {
    std::ptrdiff_t offset;
    const std::type_info* type;
    decltype(&DestroyTypeInfo) destroy = DestroyTypeInfo;
    decltype(&DeleteTypeInfo) deleteObject = DeleteTypeInfo;
    decltype(&IsPointerTypeInfoTrue) isPointer = IsPointerTypeInfoTrue;
    decltype(&IsPointerTypeInfo) isFunction = IsPointerTypeInfo;
    decltype(&CatchTypeInfo) catchType = CatchTypeInfo;
    decltype(&UpcastNonclassTypeInfo) upcast = UpcastNonclassTypeInfo;
    decltype(&CatchTypeInfo) pointerCatch = CatchTypeInfo;
};
static_assert(sizeof(FunctionTypeInfoVtable) == 8 * sizeof(void*));
static_assert(offsetof(PointerTypeInfoVtable, pointerCatch) == 8 * sizeof(void*));
#endif`],
    [`LibcException::TypeInfoVtable _ZTVN10__cxxabiv119__pointer_type_infoE_nid_postfix {
    0,
    &typeid(__cxxabiv1::__pointer_type_info),
    LibcException::DestroyTypeInfo,
    LibcException::DeleteTypeInfo,
    LibcException::IsPointerTypeInfoTrue
};
LibcException::TypeInfoVtable _ZTVN10__cxxabiv120__function_type_infoE_nid_postfix {
    0,
    &typeid(__cxxabiv1::__function_type_info),
    LibcException::DestroyTypeInfo,
    LibcException::DeleteTypeInfo,
    LibcException::IsPointerTypeInfo,
    LibcException::IsFunctionTypeInfoTrue
};`, `#ifdef __APPLE__
LibcException::PointerTypeInfoVtable _ZTVN10__cxxabiv119__pointer_type_infoE_nid_postfix {0, &typeid(__cxxabiv1::__pointer_type_info)};
LibcException::FunctionTypeInfoVtable _ZTVN10__cxxabiv120__function_type_infoE_nid_postfix {0, &typeid(__cxxabiv1::__function_type_info)};
#else
LibcException::TypeInfoVtable _ZTVN10__cxxabiv119__pointer_type_infoE_nid_postfix {
    0,
    &typeid(__cxxabiv1::__pointer_type_info),
    LibcException::DestroyTypeInfo,
    LibcException::DeleteTypeInfo,
    LibcException::IsPointerTypeInfoTrue
};
LibcException::TypeInfoVtable _ZTVN10__cxxabiv120__function_type_infoE_nid_postfix {
    0,
    &typeid(__cxxabiv1::__function_type_info),
    LibcException::DestroyTypeInfo,
    LibcException::DeleteTypeInfo,
    LibcException::IsPointerTypeInfo,
    LibcException::IsFunctionTypeInfoTrue
};
#endif`]
  ]);
  edit(root, `core/libs/prx/libkernel/Socket/src/Udp.cpp`, [
    [`            reinterpret_cast<sockaddr*>(&native), size));`, `            reinterpret_cast<sockaddr*>(&native), size));
#ifdef __APPLE__
        // macOS refuses an address on a connected datagram socket (EISCONN) where Linux sends to it; an address
        // naming the connected peer is sent there, as on Linux.
        if (result < 0 && errno == EISCONN) {
            sockaddr_storage peer{};
            socklen_t peerSize = sizeof(peer);
            const auto samePeer = [&] {
                if (peer.ss_family != native.ss_family) return false;
                if (native.ss_family == AF_INET) {
                    const auto& a = reinterpret_cast<const sockaddr_in&>(peer);
                    const auto& b = reinterpret_cast<const sockaddr_in&>(native);
                    return a.sin_port == b.sin_port && a.sin_addr.s_addr == b.sin_addr.s_addr;
                }
                const auto& a = reinterpret_cast<const sockaddr_in6&>(peer);
                const auto& b = reinterpret_cast<const sockaddr_in6&>(native);
                return a.sin6_port == b.sin6_port && a.sin6_scope_id == b.sin6_scope_id && std::memcmp(&a.sin6_addr, &b.sin6_addr, sizeof(a.sin6_addr)) == 0;
            };
            if (::getpeername(socket->value, reinterpret_cast<sockaddr*>(&peer), &peerSize) == 0 && samePeer())
                result = static_cast<int>(::send(socket->value, static_cast<const char*>(buffer), static_cast<int>(length), NativeSendFlags(flags)));
            else
                errno = EISCONN;
        }
#endif`]
  ]);
  edit(root, `core/libs/prx/libkernel/Time/TimedWait.cpp`, [
    [`    while (nanosleep(&req, &req) == -1 && errno == EINTR) {}`, `#ifdef __APPLE__
    const int savedErrno = errno;
#endif
    while (nanosleep(&req, &req) == -1 && errno == EINTR) {}
#ifdef __APPLE__
    errno = savedErrno;
#endif`]
  ]);
  edit(root, `core/libs/prx/libSceAgc/Unimplemented.cpp`, [
    [`#include "prx/libSceAgc/include/Agc.hpp"`, `#include "prx/libSceAgc/include/Agc.hpp"
#ifdef __APPLE__
#include "prx/libSceAgc/Command/include/Packet.hpp"
#endif`],
    [`int APS5_VABI sceAgcAcquireMemSetEngine(std::uint32_t* packet, std::uint8_t engine) {
 NotImplemented_nid_no_patch(__func__);
 return 0;
}`, `#ifdef __APPLE__
int APS5_VABI sceAgcAcquireMemSetEngine(std::uint32_t* packet, std::uint8_t engine) {
    Agc::Command::ValidatePacket(packet, 0x58u, 8, __func__);
    Agc::Command::CheckBits(engine, 1, __func__);
    packet[1] = (packet[1] & 0x7fffffffu) | (static_cast<std::uint32_t>(engine) << 31u);
    return 0;
}
#else
int APS5_VABI sceAgcAcquireMemSetEngine(std::uint32_t* packet, std::uint8_t engine) {
 NotImplemented_nid_no_patch(__func__);
 return 0;
}
#endif`]
  ]);
  edit(root, `core/shader/recompiler/RdnaDecoder/src/RdnaMemoryOpDecoder.cpp`, [
    [`        if (offset0 == offset1) {
            throw std::runtime_error("DS write exchange of one location through both offsets is not supported");
        }`, `#ifndef __APPLE__
        if (offset0 == offset1) {
            throw std::runtime_error("DS write exchange of one location through both offsets is not supported");
        }
#endif`]
  ]);
  return ["core/relinker/elfpatcher/src/macos/MacOsImage.cpp","core/libs/prx/libc/src/GuestAllocations.cpp","core/libs/prx/libkernel/Time/Time.cpp","core/libs/prx/libSceFontFt/Export.cpp","core/libs/prx/libSceVoice/Export.cpp","core/libs/prx/libc/Export.cpp","core/libs/prx/libc/include/Api.hpp","core/libs/prx/libc/src/exception/TypeInfo.cpp","core/libs/prx/libkernel/Socket/src/Udp.cpp","core/libs/prx/libkernel/Time/TimedWait.cpp","core/libs/prx/libSceAgc/Unimplemented.cpp","core/shader/recompiler/RdnaDecoder/src/RdnaMemoryOpDecoder.cpp"];
}
