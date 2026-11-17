// SPDX-License-Identifier: GPL-2.0-only
#ifndef CORE_LIBS_PRX_LIBC_INCLUDE_GUESTCPUARM64_HPP
#define CORE_LIBS_PRX_LIBC_INCLUDE_GUESTCPUARM64_HPP

#include <array>
#include <cstdint>

namespace GuestCpu {

struct HostAccessors {
    std::uint64_t (*ReadTsc)();
    std::array<std::uint32_t, 4> (*Cpuid)(std::uint32_t, std::uint32_t);
    std::uint64_t (*Xgetbv)(std::uint32_t);
    std::uint32_t (*Mxcsr)();
    void (*SetMxcsr)(std::uint32_t);
    std::uint16_t (*X87Control)();
    void (*SetX87Control)(std::uint16_t);
    std::uint16_t (*X87Status)();
    void (*SetX87Status)(std::uint16_t);
    void (*X87ClearExceptions)();
    void (*X87Wait)();
    std::uint32_t (*MxcsrMask)();
    std::array<std::uint32_t, 7> (*X87Environment)();
    void (*SetX87Environment)(const std::array<std::uint32_t, 7>&);
    void (*RaiseInvalidForSignalingNan)(float);
};

}

extern "C" void GuestCpuInstallHost_nid_no_patch(const GuestCpu::HostAccessors* accessors);
extern "C" const GuestCpu::HostAccessors& GuestCpuHost_nid_no_patch();

namespace GuestCpu {

inline std::uint64_t ReadTsc() { return GuestCpuHost_nid_no_patch().ReadTsc(); }
inline std::array<std::uint32_t, 4> Cpuid(std::uint32_t leaf, std::uint32_t subleaf) { return GuestCpuHost_nid_no_patch().Cpuid(leaf, subleaf); }
inline std::uint64_t Xgetbv(std::uint32_t index) { return GuestCpuHost_nid_no_patch().Xgetbv(index); }
inline std::uint32_t Mxcsr() { return GuestCpuHost_nid_no_patch().Mxcsr(); }
inline void SetMxcsr(std::uint32_t value) { GuestCpuHost_nid_no_patch().SetMxcsr(value); }
inline std::uint16_t X87Control() { return GuestCpuHost_nid_no_patch().X87Control(); }
inline void SetX87Control(std::uint16_t value) { GuestCpuHost_nid_no_patch().SetX87Control(value); }
inline std::uint16_t X87Status() { return GuestCpuHost_nid_no_patch().X87Status(); }
inline void SetX87Status(std::uint16_t value) { GuestCpuHost_nid_no_patch().SetX87Status(value); }
inline void X87ClearExceptions() { GuestCpuHost_nid_no_patch().X87ClearExceptions(); }
inline void X87Wait() { GuestCpuHost_nid_no_patch().X87Wait(); }
inline std::uint32_t MxcsrMask() { return GuestCpuHost_nid_no_patch().MxcsrMask(); }
inline std::array<std::uint32_t, 7> X87Environment() { return GuestCpuHost_nid_no_patch().X87Environment(); }
inline void SetX87Environment(const std::array<std::uint32_t, 7>& value) { GuestCpuHost_nid_no_patch().SetX87Environment(value); }
inline void RaiseInvalidForSignalingNan(float value) { GuestCpuHost_nid_no_patch().RaiseInvalidForSignalingNan(value); }

}

#endif
