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
    AsTypeInfo(_ZTIN10__cxxabiv119__pointer_type_infoE_nid_postfix),
    LibcException::DestroyTypeInfo,
    LibcException::DeleteTypeInfo,
    LibcException::IsPointerTypeInfoTrue
};
LibcException::TypeInfoVtable _ZTVN10__cxxabiv120__function_type_infoE_nid_postfix {
    0,
    AsTypeInfo(_ZTIN10__cxxabiv120__function_type_infoE_nid_postfix),
    LibcException::DestroyTypeInfo,
    LibcException::DeleteTypeInfo,
    LibcException::IsPointerTypeInfo,
    LibcException::IsFunctionTypeInfoTrue
};`, `#ifdef __APPLE__
LibcException::PointerTypeInfoVtable _ZTVN10__cxxabiv119__pointer_type_infoE_nid_postfix {0, AsTypeInfo(_ZTIN10__cxxabiv119__pointer_type_infoE_nid_postfix)};
LibcException::FunctionTypeInfoVtable _ZTVN10__cxxabiv120__function_type_infoE_nid_postfix {0, AsTypeInfo(_ZTIN10__cxxabiv120__function_type_infoE_nid_postfix)};
#else
LibcException::TypeInfoVtable _ZTVN10__cxxabiv119__pointer_type_infoE_nid_postfix {
    0,
    AsTypeInfo(_ZTIN10__cxxabiv119__pointer_type_infoE_nid_postfix),
    LibcException::DestroyTypeInfo,
    LibcException::DeleteTypeInfo,
    LibcException::IsPointerTypeInfoTrue
};
LibcException::TypeInfoVtable _ZTVN10__cxxabiv120__function_type_infoE_nid_postfix {
    0,
    AsTypeInfo(_ZTIN10__cxxabiv120__function_type_infoE_nid_postfix),
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
  // Upstream preserves errno around SleepNanos on every POSIX host.
  edit(root, `core/shader/recompiler/RdnaDecoder/src/RdnaMemoryOpDecoder.cpp`, [
    [`        if (offset0 == offset1) {
            throw std::runtime_error("DS write exchange of one location through both offsets is not supported");
        }`, `#ifndef __APPLE__
        if (offset0 == offset1) {
            throw std::runtime_error("DS write exchange of one location through both offsets is not supported");
        }
#endif`]
  ]);
  return ["core/relinker/elfpatcher/src/macos/MacOsImage.cpp","core/libs/prx/libc/src/GuestAllocations.cpp","core/libs/prx/libkernel/Time/Time.cpp","core/libs/prx/libSceFontFt/Export.cpp","core/libs/prx/libSceVoice/Export.cpp","core/libs/prx/libc/Export.cpp","core/libs/prx/libc/include/Api.hpp","core/libs/prx/libc/src/exception/TypeInfo.cpp","core/libs/prx/libkernel/Socket/src/Udp.cpp","core/shader/recompiler/RdnaDecoder/src/RdnaMemoryOpDecoder.cpp"];
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * __ELF maxprot and padding registration:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/8bc1dd19dcec1fe67d7e14184e2def07015905fc
 * Mach thread CPU clock:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/badae20dcda5b86ca1c14338968c9b8c641d70c4
 * system font modules:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/06668165a2a8161b6c744a6268d37714c30f4ab4
 * _Atomic_assert:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/0666b5a7e99958cd2902ec6fc89bbeedc5a4279c
 * function/pointer RTTI shape:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/cad9217fbf1a9cfb6a4f0a00d8af60c17cd8033a
 * connected UDP sendto fallback:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/25b128d615f0d35c96388436009a6adcb270da15
 * errno preservation during nanosleep:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/93c711786ec94d3bcad28e7016c5feac604d15a4
 * AGC acquire-memory engine selection:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/c1d06dd1c6853923dc631f537b80e66fd73074a5
 * equal-offset ds_wrxchg2:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/51f930b813e37171a3b6dd9b81134df9c0d1f512
 * Portions adapted from AnyPS5 (GPL-2.0-only).
 * adapted voice input-port validation:
 * https://github.com/boykopovar/AnyPS5/commit/648fba4f71b54f86418c3dbaae60b91e7ef6dffa
 */
