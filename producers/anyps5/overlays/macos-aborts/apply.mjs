// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

export function replace(source, before, after, file) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 Apple compatibility boundary changed: ' + file + ': ' + before.slice(0, 80));
  return source.replace(before, after);
}
export function edit(root, file, replacements) {
  const target = path.join(root, file);
  let source = fs.readFileSync(target, 'utf8');
  for (const [before, after] of replacements) source = replace(source, before, after, file);
  fs.writeFileSync(target, source);
}
export function applyAbortsOverlay(root) {
  edit(root, `core/libs/prx/libkernel/Equeue/Equeue.cpp`, [
    [`    const std::int64_t offset = sceKernelLseek(file, 0, 1);`, `#ifdef __APPLE__
    const auto type = status.st_mode & 0170000;
    if (type != 0100000 && type != 0040000) return {true, 1};
#endif
    const std::int64_t offset = sceKernelLseek(file, 0, 1);`],
    [`            if (!unread->measured || unread->bytes == 0) {`, `            if (!unread->measured || unread->bytes
#ifdef __APPLE__
                <= 0
#else
                == 0
#endif
            ) {`],
    [`static bool RegularFile(int descriptor) {`, `static bool RegularFile(int descriptor) {
#ifdef __APPLE__
    FileStat status{};
    return sceKernelFstat(descriptor, &status) == 0;
#else`],
    [`    return sceKernelFstat(descriptor, &status) == 0 && (status.st_mode & 0170000) == 0100000;`, `    return sceKernelFstat(descriptor, &status) == 0 && (status.st_mode & 0170000) == 0100000;
#endif`],
    [`            wait.interests.push_back({static_cast<int>(e.event.ident), e.event.filter == EVFILT_WRITE});`, `#ifdef __APPLE__
            if (e.lowWater > 1) wait.repoll = true;
            else
#endif
            wait.interests.push_back({static_cast<int>(e.event.ident), e.event.filter == EVFILT_WRITE});`],
    [`    if (size > 1 && !isPipe) {`, `#ifndef __APPLE__
    if (size > 1 && !isPipe) {`],
    [`    if (!isSocket && !isPipe && !isFile) {`, `    #endif
    if (!isSocket && !isPipe && !isFile) {`],
    [`    return EqueueAddEvent_nid_postfix(eq, EqueueDescriptorEvent(fd, filter, EV_ADD, udata));`, `    auto event = EqueueDescriptorEvent(fd, filter, EV_ADD, udata);
#ifdef __APPLE__
    if (size > static_cast<std::size_t>(std::numeric_limits<std::int64_t>::max())) return SCE_KERNEL_ERROR_EINVAL;
    event.lowWater = static_cast<std::int64_t>(size);
#endif
    return EqueueAddEvent_nid_postfix(eq, event);`],
    [`KernelEqueueEvent EqueueDescriptorEvent(int descriptor, int16_t filter, uint16_t flags, void* udata) {`, `KernelEqueueEvent EqueueDescriptorEvent(int descriptor, int16_t filter, uint16_t flags, void* udata) {
#ifdef __APPLE__
    std::int64_t pipeBytes = 0;
    bool pipeEof = false;
    bool pipeWritable = false;
    const bool pipe = filter == EVFILT_READ ? GuestSockets::PipeReadState(descriptor, &pipeBytes, &pipeEof) : GuestSockets::PipeWriteState(descriptor, &pipeBytes, &pipeEof, &pipeWritable);
    if (!GuestSockets::IsOpen(descriptor) && !pipe) return FileEvent(descriptor, filter, flags, udata);
#endif`]
  ]);
  edit(root, `core/libs/prx/libkernel/Equeue/src/Kqueue.cpp`, [
    [`std::int64_t DescriptorLowWater(const KernelEvent& change) {
    if ((change.fflags & NOTE_LOWAT) == 0 || !GuestSockets::IsOpen(static_cast<int>(change.ident))) {
        return 0;
    }
    if (change.data < 1 && change.filter == EVFILT_WRITE) {
        NotImplemented_nid_no_patch("kevent: EVFILT_WRITE with NOTE_LOWAT below 1 on a socket");
    }
    if (change.data > 1 && GuestSockets::Type(static_cast<int>(change.ident)) != 1) {
        NotImplemented_nid_no_patch("kevent: NOTE_LOWAT above 1 on a socket that is not a stream");
    }
    return change.data;
}`, `#ifdef __APPLE__
std::int64_t DescriptorLowWater(const KernelEvent& change) {
    if ((change.fflags & NOTE_LOWAT) == 0 || !GuestSockets::IsOpen(static_cast<int>(change.ident))) return 0;
    return std::max<std::int64_t>(1, change.data);
}
#else
std::int64_t DescriptorLowWater(const KernelEvent& change) {
    if ((change.fflags & NOTE_LOWAT) == 0 || !GuestSockets::IsOpen(static_cast<int>(change.ident))) {
        return 0;
    }
    if (change.data < 1 && change.filter == EVFILT_WRITE) {
        NotImplemented_nid_no_patch("kevent: EVFILT_WRITE with NOTE_LOWAT below 1 on a socket");
    }
    if (change.data > 1 && GuestSockets::Type(static_cast<int>(change.ident)) != 1) {
        NotImplemented_nid_no_patch("kevent: NOTE_LOWAT above 1 on a socket that is not a stream");
    }
    return change.data;
}
#endif`],
    [`    if (!socket && !pipe) {
        NotImplemented_nid_no_patch(change.filter`, `#ifndef __APPLE__
    if (!socket && !pipe) {
        NotImplemented_nid_no_patch(change.filter`],
    [`    if (pipe && change.filter == EVFILT_WRITE && eof) {`, `#endif
    if (pipe && change.filter == EVFILT_WRITE && eof) {`],
    [`    if ((flags & EV_CLEAR) != 0) {
        WatchEdges(event, socket);`, `    if ((flags & EV_CLEAR) != 0
#ifdef __APPLE__
        && (socket || pipe)
#endif
    ) {
        WatchEdges(event, socket);`]
  ]);
  edit(root, `core/libs/prx/libkernel/DirectMemory/Jit.cpp`, [
    [`namespace {`, `#ifdef __APPLE__
#include "prx/libc/include/GuestWriteWatch.hpp"
#include <atomic>
#include <cstdio>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#endif

namespace {`],
    [`    explicit JitObject(std::size_t bytes) : bytes(bytes) {}`, `#ifdef __APPLE__
    JitObject(std::size_t bytes, void* memory) : bytes(bytes), memory(memory) {}
    ~JitObject() { ::munmap(memory, bytes); }
#else
    explicit JitObject(std::size_t bytes) : bytes(bytes) {}
#endif`],
    [`    HostSharedMemory Host(int descriptor) const {`, `#ifdef __APPLE__
    void* Memory() const { return memory; }
#else
    HostSharedMemory Host(int descriptor) const {`],
    [`private:
    std::size_t bytes;`, `#endif

private:
    std::size_t bytes;`],
    [`    HANDLE section;
#endif`, `    HANDLE section;
#elif defined(__APPLE__)
    void* memory;
#endif`],
    [`#else
int CreateBacking(std::size_t bytes, int* descriptor, std::shared_ptr<JitObject>* object) {`, `#else
#ifdef __APPLE__
// Under Rosetta no descriptor maps runnable code: a PROT_EXEC mapping of a regular file is refused (EPERM) and
// code in a POSIX shared memory mapping faults when run. The object's memory is anonymous shared memory that
// every view aliases (MapView); the descriptor is an unlinked shared memory object of the same size that names
// the object: fstat sees its size, and read and write on it fail (ENXIO) rather than reach other contents.
int CreateBacking(std::size_t bytes, int* descriptor, std::shared_ptr<JitObject>* object) {
    static std::atomic<unsigned> sequence{0};
    char name[32];
    std::snprintf(name, sizeof(name), "/aps5-jit-%d-%u", static_cast<int>(::getpid()), sequence.fetch_add(1));
    const int file = ::shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (file < 0) return HostFailure("create JIT shared memory", errno);
    ::shm_unlink(name);
    ::fcntl(file, F_SETFD, FD_CLOEXEC);
    const bool representable = bytes <= static_cast<std::uint64_t>(std::numeric_limits<off_t>::max());
    if (!representable || ftruncate(file, static_cast<off_t>(bytes)) != 0) {
        const int error = !representable || errno == EFBIG ? ENOMEM : errno;
        ::close(file);
        return HostFailure("size JIT shared memory", error);
    }
    void* memory = ::mmap(nullptr, bytes, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANON, -1, 0);
    if (memory == MAP_FAILED) {
        const int error = errno;
        ::close(file);
        return HostFailure("allocate JIT shared memory", error);
    }
    *descriptor = file;
    *object = std::make_shared<JitObject>(bytes, memory);
    return 0;
}

int NativeProtection(int protection) {
    const int granted = Granted(protection);
    return ((granted & CpuRead) != 0 ? PROT_READ : 0) | ((granted & CpuWrite) != 0 ? PROT_WRITE : 0) | ((granted & CpuExecute) != 0 ? PROT_EXEC : 0);
}

// Places the view as anonymous guest memory, then replaces its pages with an alias of the object's memory.
// Rosetta keeps the translation of code it ran through a view after a store through another view, so code a JIT
// rewrites in place after running it stays stale until the executable view's protection changes.
int MapView(void** address, const JitObject& object, int protection) {
    const std::size_t bytes = object.Bytes();
    if (const int result = DoMapAnon(address, bytes, protection, 0)) return result;
    GuestWriteWatch::GuestWriteWatchUnregister_nid_postfix(*address, bytes);
    auto view = reinterpret_cast<mach_vm_address_t>(*address);
    vm_prot_t current = VM_PROT_NONE;
    vm_prot_t maximum = VM_PROT_NONE;
    const kern_return_t remapped = mach_vm_remap(mach_task_self(), &view, bytes, 0, VM_FLAGS_FIXED | VM_FLAGS_OVERWRITE, mach_task_self(),
                                                 reinterpret_cast<mach_vm_address_t>(object.Memory()), FALSE, &current, &maximum, VM_INHERIT_SHARE);
    if (remapped != KERN_SUCCESS) {
        DoMunmap(*address, bytes);
        throw std::runtime_error(std::string("map JIT shared memory: mach_vm_remap failed: ") + mach_error_string(remapped));
    }
    if (::mprotect(*address, bytes, NativeProtection(protection)) != 0) {
        const int error = errno;
        DoMunmap(*address, bytes);
        throw std::system_error(error, std::generic_category(), "protect JIT shared memory view");
    }
    return 0;
}
#else
int CreateBacking(std::size_t bytes, int* descriptor, std::shared_ptr<JitObject>* object) {`],
    [`int DuplicateDescriptor(int descriptor) {
    return fcntl(descriptor, F_DUPFD_CLOEXEC, 0);`, `#endif
int DuplicateDescriptor(int descriptor) {
    return fcntl(descriptor, F_DUPFD_CLOEXEC, 0);`],
    [`    if (const int result = DoMapShared(&address, object.Bytes(), prot, object.Host(fd))) return result;`, `#ifdef __APPLE__
    if (const int result = MapView(&address, object, prot)) return result;
#else
    if (const int result = DoMapShared(&address, object.Bytes(), prot, object.Host(fd))) return result;
#endif`]
  ]);
  edit(root, `core/libs/prx/libScePad/Export.cpp`, [
    [` if (type != PAD_PORT_TYPE_SPECIAL) NotImplemented_nid_no_patch(__func__);`, `#ifdef __APPLE__
 if (type != PAD_PORT_TYPE_SPECIAL) return scePadOpen_nid_postfix(userId, type, index, param);
#else
 if (type != PAD_PORT_TYPE_SPECIAL) NotImplemented_nid_no_patch(__func__);
#endif`],
    [`int APS5_VABI scePadReadExt(std::int32_t handle, PadDataExtended* data, std::int32_t count) { NotImplemented_nid_no_patch(__func__); return 0; }`, `#ifdef __APPLE__
int APS5_VABI scePadReadExt(std::int32_t handle, PadDataExtended* data, std::int32_t count) {
 if (!KnownHandle(handle) && !RemoteHandle(handle)) return PAD_ERROR_INVALID_HANDLE;
 if (SpecialHandle(handle)) return PAD_ERROR_INVALID_HANDLE;
 if (data == nullptr || count <= 0) return PAD_ERROR_INVALID_ARG;
 // Standard ports return the same records as scePadRead. Keep the opaque public pointer type.
 std::vector<PadData> states(static_cast<std::size_t>(count));
 const int result = scePadRead_nid_postfix(handle, states.data(), count);
 if (result > 0) std::memcpy(static_cast<void*>(data), states.data(), static_cast<std::size_t>(result) * sizeof(PadData));
 return result;
}
#else
int APS5_VABI scePadReadExt(std::int32_t handle, PadDataExtended* data, std::int32_t count) { NotImplemented_nid_no_patch(__func__); return 0; }
#endif`],
    [`int APS5_VABI scePadGetFeatureReport(std::int32_t handle, std::uint8_t reportId, void* data, std::size_t size) { NotImplemented_nid_no_patch(__func__); return 0; }`, `#ifdef __APPLE__
int APS5_VABI scePadGetFeatureReport(std::int32_t handle, std::uint8_t reportId, void* data, std::size_t size) {
 return PAD_ERROR_INVALID_HANDLE;
}
#else
int APS5_VABI scePadGetFeatureReport(std::int32_t handle, std::uint8_t reportId, void* data, std::size_t size) { NotImplemented_nid_no_patch(__func__); return 0; }
#endif`],
    [`int APS5_VABI scePadSetFeatureReport(std::int32_t handle, std::uint8_t reportId, const void* data, std::size_t size) { NotImplemented_nid_no_patch(__func__); return 0; }`, `#ifdef __APPLE__
int APS5_VABI scePadSetFeatureReport(std::int32_t handle, std::uint8_t reportId, const void* data, std::size_t size) {
 return PAD_ERROR_INVALID_HANDLE;
}
#else
int APS5_VABI scePadSetFeatureReport(std::int32_t handle, std::uint8_t reportId, const void* data, std::size_t size) { NotImplemented_nid_no_patch(__func__); return 0; }
#endif`],
    [`int APS5_VABI scePadOutputReport(std::int32_t handle, std::uint8_t reportId, const void* data, std::uint64_t size) { NotImplemented_nid_no_patch(__func__); return 0; }`, `#ifdef __APPLE__
int APS5_VABI scePadOutputReport(std::int32_t handle, std::uint8_t reportId, const void* data, std::uint64_t size) {
 return PAD_ERROR_INVALID_HANDLE;
}
#else
int APS5_VABI scePadOutputReport(std::int32_t handle, std::uint8_t reportId, const void* data, std::uint64_t size) { NotImplemented_nid_no_patch(__func__); return 0; }
#endif`],
    [`int APS5_VABI scePadVrControllerGetDeviceInformation(std::int32_t handle, PadVrControllerDeviceInformation* info) {
 NotImplemented_nid_no_patch(__func__);
 return 0;
}`, `#ifdef __APPLE__
int APS5_VABI scePadVrControllerGetDeviceInformation(std::int32_t handle, PadVrControllerDeviceInformation* info) {
 return PAD_ERROR_INVALID_HANDLE;
}
#else
int APS5_VABI scePadVrControllerGetDeviceInformation(std::int32_t handle, PadVrControllerDeviceInformation* info) {
 NotImplemented_nid_no_patch(__func__);
 return 0;
}
#endif`],
    [`int APS5_VABI scePadVrControllerRead(std::int32_t handle, PadVrControllerData* data, std::int32_t count) {
 NotImplemented_nid_no_patch(__func__);
 return 0;
}`, `#ifdef __APPLE__
int APS5_VABI scePadVrControllerRead(std::int32_t handle, PadVrControllerData* data, std::int32_t count) {
 return PAD_ERROR_INVALID_HANDLE;
}
#else
int APS5_VABI scePadVrControllerRead(std::int32_t handle, PadVrControllerData* data, std::int32_t count) {
 NotImplemented_nid_no_patch(__func__);
 return 0;
}
#endif`],
    [`#include <cstring>`, `#include <cstring>
#ifdef __APPLE__
#include <vector>
#endif`]
  ]);
  return ["core/libs/prx/libkernel/Equeue/Equeue.cpp","core/libs/prx/libkernel/Equeue/src/Kqueue.cpp","core/libs/prx/libSceSysmodule/Export.cpp","core/libs/prx/libkernel/DirectMemory/Jit.cpp","core/libs/prx/libScePad/Export.cpp"];
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * file/device readiness and low-water repoll:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/08f55bff3ed9cfe03a74bf4de239ba102affa336
 * Sysmodule unwind delegation:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/de9ccf921a1ff124310bd15fc68021d8f9d5b63e
 * shared Mach JIT mappings:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/5151ee2320b01cecd2bd5559d58ea0d93a36cb6e
 * standard extended-pad open and absent-device results:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/2d0c051852e841b04fe0c885319337d7ac87636c
 * standard extended-pad reads:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/43ab8eded0570d967ff9301ae414d9ddfed80610
 */
