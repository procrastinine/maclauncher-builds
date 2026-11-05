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
    if (change.data < 1) {
        NotImplemented_nid_no_patch("kevent: NOTE_LOWAT below 1 on a socket");
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
    if (change.data < 1) {
        NotImplemented_nid_no_patch("kevent: NOTE_LOWAT below 1 on a socket");
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
  edit(root, `core/libs/prx/libSceSysmodule/Export.cpp`, [
    [`namespace {`, `#ifdef __APPLE__
extern "C" int APS5_VABI sceKernelGetModuleInfoForUnwind(std::uint64_t addr, int flags, ModuleInfoForUnwind* info);
#endif

namespace {`],
    [`    (void)flags;
    if (!fillModuleInfoForUnwind(addr, info)) {`, `#ifdef __APPLE__
    if (sceKernelGetModuleInfoForUnwind(addr, flags, info) == 0) return 0;
#else
    (void)flags;
    if (fillModuleInfoForUnwind(addr, info)) return 0;
#endif
    {`]
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
  edit(root, `core/libs/prx/libSceNet/Export.cpp`, [
    [`static int fill_sock_info(`, `#ifdef __APPLE__
struct KernelSocket {
    std::shared_ptr<void> owner;
    NativeSocket native = INVALID_NATIVE_SOCKET;
};

bool find_kernel_socket(int descriptor, KernelSocket& found) {
    if (!GuestSocketIsOpen_nid_no_patch(descriptor)) return false;
    std::uintptr_t native = 0;
    if (!KernelLookupSocketNative_nid_no_patch(descriptor, &found.owner, &native) || !found.owner) return false;
    found.native = static_cast<NativeSocket>(native);
    return true;
}

#endif

static int fill_sock_info(`],
    [`static int fill_sock_info(int s, NetSockInfo& record) {
    Sock socket;
    {
        std::lock_guard lk(g_mutex);
        const auto it = g_socks.find(s);
        if (it == g_socks.end()) return NET_EBADF;
        socket = it->second;
    }
    if (socket.family != NET_AF_INET) return NET_EAFNOSUPPORT;
    sockaddr_in local{};
    NativeLength length = sizeof(local);
    if (::getsockname(socket.native->value, reinterpret_cast<sockaddr*>(&local), &length) != 0) {
#ifdef _WIN32
        if (WSAGetLastError() != WSAEINVAL) return native_error();
#else
        return native_error();
#endif
    }
    sockaddr_in remote{};
    length = sizeof(remote);
    if (::getpeername(socket.native->value, reinterpret_cast<sockaddr*>(&remote), &length) != 0) {
        const int error = native_error();
        if (error != NET_ENOTCONN) return error;
    }
    record = {};
    if (const int error = sock_buffer_size(socket, false, record.recv_buffer_size)) return error;
    if (const int error = sock_buffer_size(socket, true, record.send_buffer_size)) return error;
    record.s = s;
    record.socket_type = static_cast<std::int8_t>(socket.type);
    record.local_adr = local.sin_addr.s_addr;
    record.remote_adr = remote.sin_addr.s_addr;
    record.local_port = local.sin_port;
    record.remote_port = remote.sin_port;
    record.flags = NET_SOCKINFO_F_SELF | (socket.native->nonblock ? NET_SOCKINFO_F_NONBLOCK : 0);
    return 0;
}`, `#ifdef __APPLE__
static int fill_sock_info(int s, NetSockInfo& record) {
    Sock socket;
    bool found = false;
    {
        std::lock_guard lk(g_mutex);
        const auto it = g_socks.find(s);
        if (it != g_socks.end()) {
            socket = it->second;
            found = true;
        }
    }
    KernelSocket kernel;
    if (!found && !find_kernel_socket(s, kernel)) return NET_EBADF;
    if (found && socket.family != NET_AF_INET) return NET_EAFNOSUPPORT;
    const NativeSocket native = found ? socket.native->value : kernel.native;
    sockaddr_in local{};
    NativeLength length = sizeof(local);
    if (::getsockname(native, reinterpret_cast<sockaddr*>(&local), &length) != 0) {
#ifdef _WIN32
        if (WSAGetLastError() != WSAEINVAL) return native_error();
#else
        return native_error();
#endif
    }
    if (!found && local.sin_family != AF_INET) return NET_EAFNOSUPPORT;
    sockaddr_in remote{};
    length = sizeof(remote);
    if (::getpeername(native, reinterpret_cast<sockaddr*>(&remote), &length) != 0) {
        const int error = native_error();
        if (error != NET_ENOTCONN) return error;
    }
    record = {};
    int type = socket.type;
    bool nonblock = false;
    if (found) {
        if (const int error = sock_buffer_size(socket, false, record.recv_buffer_size)) return error;
        if (const int error = sock_buffer_size(socket, true, record.send_buffer_size)) return error;
        nonblock = socket.native->nonblock;
    } else {
        int nativeType = 0;
        NativeLength size = sizeof(nativeType);
        if (::getsockopt(native, SOL_SOCKET, SO_TYPE, reinterpret_cast<char*>(&nativeType), &size) != 0) return native_error();
        type = nativeType == SOCK_STREAM ? NET_SOCK_STREAM : NET_SOCK_DGRAM;
        size = sizeof(record.recv_buffer_size);
        if (::getsockopt(native, SOL_SOCKET, SO_RCVBUF, reinterpret_cast<char*>(&record.recv_buffer_size), &size) != 0) return native_error();
        size = sizeof(record.send_buffer_size);
        if (::getsockopt(native, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<char*>(&record.send_buffer_size), &size) != 0) return native_error();
        int state = 0;
        std::uint32_t stateSize = sizeof(state);
        nonblock = getsockopt_nid_postfix(s, NET_SOL_SOCKET, NET_SO_NBIO, &state, &stateSize) == 0 && state != 0;
    }
    record.s = s;
    record.socket_type = static_cast<std::int8_t>(type);
    record.local_adr = local.sin_addr.s_addr;
    record.remote_adr = remote.sin_addr.s_addr;
    record.local_port = local.sin_port;
    record.remote_port = remote.sin_port;
    record.flags = NET_SOCKINFO_F_SELF | (nonblock ? NET_SOCKINFO_F_NONBLOCK : 0);
    return 0;
}
#else
static int fill_sock_info(int s, NetSockInfo& record) {
    Sock socket;
    {
        std::lock_guard lk(g_mutex);
        const auto it = g_socks.find(s);
        if (it == g_socks.end()) return NET_EBADF;
        socket = it->second;
    }
    if (socket.family != NET_AF_INET) return NET_EAFNOSUPPORT;
    sockaddr_in local{};
    NativeLength length = sizeof(local);
    if (::getsockname(socket.native->value, reinterpret_cast<sockaddr*>(&local), &length) != 0) {
#ifdef _WIN32
        if (WSAGetLastError() != WSAEINVAL) return native_error();
#else
        return native_error();
#endif
    }
    sockaddr_in remote{};
    length = sizeof(remote);
    if (::getpeername(socket.native->value, reinterpret_cast<sockaddr*>(&remote), &length) != 0) {
        const int error = native_error();
        if (error != NET_ENOTCONN) return error;
    }
    record = {};
    if (const int error = sock_buffer_size(socket, false, record.recv_buffer_size)) return error;
    if (const int error = sock_buffer_size(socket, true, record.send_buffer_size)) return error;
    record.s = s;
    record.socket_type = static_cast<std::int8_t>(socket.type);
    record.local_adr = local.sin_addr.s_addr;
    record.remote_adr = remote.sin_addr.s_addr;
    record.local_port = local.sin_port;
    record.remote_port = remote.sin_port;
    record.flags = NET_SOCKINFO_F_SELF | (socket.native->nonblock ? NET_SOCKINFO_F_NONBLOCK : 0);
    return 0;
}
#endif`]
  ]);
  edit(root, `core/libs/prx/libScePad/Export.cpp`, [
    [` if (unknownType) NotImplemented_nid_no_patch(__func__);`, `#ifdef __APPLE__
 if (unknownType) return PAD_ERROR_INVALID_ARG;
#else
 if (unknownType) NotImplemented_nid_no_patch(__func__);
#endif`],
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
  edit(root, `core/libs/prx/libSceUsbd/Export.cpp`, [
    [`#include <algorithm>`, `#include <algorithm>
#ifdef __APPLE__
#include <atomic>
#include <condition_variable>
#endif`],
    [`void LIBUSB_CALL CompleteTransfer(`, `#ifdef __APPLE__
struct UsbdEvents {
    std::mutex lock;
    std::condition_variable changed;
    std::atomic<std::thread::id> owner{};
    std::atomic<std::thread::id> handler{};
    std::atomic<std::uint64_t> completions{0};
};

UsbdEvents& Events() {
    static auto* events = new UsbdEvents();
    return *events;
}

bool ValidTimeout(const UsbdTimeval* timeout) {
    return timeout == nullptr || (timeout->seconds >= 0 && timeout->seconds <= INT_MAX && timeout->microseconds >= 0 && timeout->microseconds < 1000000);
}

void AcquireEvents(UsbdEvents& events, const char* function) {
    const auto self = std::this_thread::get_id();
    if (events.owner.load() == self) throw std::runtime_error(std::string(function) + ": this thread already holds the event lock");
    events.lock.lock();
    events.owner.store(self);
}

void RequireEventLock(UsbdEvents& events, const char* function) {
    if (events.owner.load() != std::this_thread::get_id()) throw std::runtime_error(std::string(function) + ": this thread does not hold the event lock");
}

void ReleaseEvents(UsbdEvents& events, const char* function) {
    RequireEventLock(events, function);
    events.owner.store(std::thread::id{});
    events.lock.unlock();
}

void LockEventsAndClaim(UsbdEvents& events, const char* function) {
    AcquireEvents(events, function);
    if (events.handler.load() == std::thread::id{}) events.handler.store(std::this_thread::get_id());
}

void UnlockEventsAndRelease(UsbdEvents& events, const char* function) {
    RequireEventLock(events, function);
    if (events.handler.load() == std::this_thread::get_id()) {
        events.handler.store(std::thread::id{});
        events.changed.notify_all();
    }
    ReleaseEvents(events, function);
}

int WaitForChange(UsbdEvents& events, const UsbdTimeval* timeout) {
    const auto self = std::this_thread::get_id();
    std::unique_lock guard(events.lock, std::adopt_lock);
    events.owner.store(std::thread::id{});
    bool timedOut = false;
    if (timeout == nullptr) {
        events.changed.wait(guard);
    } else {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(timeout->seconds) + std::chrono::microseconds(timeout->microseconds);
        timedOut = events.changed.wait_until(guard, deadline) == std::cv_status::timeout;
    }
    guard.release();
    events.owner.store(self);
    if (events.handler.load() == std::thread::id{}) events.handler.store(self);
    return timedOut ? 1 : 0;
}

libusb_context* CurrentContext();

int HandleAsHandler(UsbdEvents& events, const UsbdTimeval* timeout) {
    const auto self = std::this_thread::get_id();
    const auto before = events.completions.load();
    events.owner.store(std::thread::id{});
    events.lock.unlock();
    libusb_context* context = CurrentContext();
    int result = 0;
    if (timeout != nullptr && context == nullptr) {
        std::this_thread::sleep_for(std::chrono::seconds(timeout->seconds) + std::chrono::microseconds(timeout->microseconds));
    } else if (timeout != nullptr) {
        timeval host{};
        host.tv_sec = static_cast<decltype(host.tv_sec)>(timeout->seconds);
        host.tv_usec = static_cast<decltype(host.tv_usec)>(timeout->microseconds);
        result = libusb_handle_events_timeout_completed(context, &host, nullptr);
    } else {
        while (result == 0 && events.completions.load() == before) {
            if (context == nullptr) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            } else {
                timeval slice{};
                slice.tv_sec = 1;
                result = libusb_handle_events_timeout_completed(context, &slice, nullptr);
            }
        }
    }
    events.lock.lock();
    events.owner.store(self);
    events.changed.notify_all();
    return result;
}

std::int32_t HandleEventsLocked(UsbdEvents& events, const UsbdTimeval* timeout) {
    if (events.handler.load() == std::this_thread::get_id()) return ToGuestError(HandleAsHandler(events, timeout));
    return WaitForChange(events, timeout) != 0 ? ToGuestError(LIBUSB_ERROR_TIMEOUT) : 0;
}

#endif

void LIBUSB_CALL CompleteTransfer(`],
    [`std::int32_t APS5_VABI sceUsbdHandleEventsTimeout(const UsbdTimeval* timeout) {
    if (timeout == nullptr || timeout->seconds < 0 || timeout->microseconds < 0 || timeout->microseconds >= 1000000) return SCE_USBD_ERROR_INVALID_ARG;
    libusb_context* context;
    {
        auto& state = State();
        std::lock_guard lock(state.mutex);
        context = state.context;
    }
    if (context == nullptr) {
        std::this_thread::sleep_for(std::chrono::seconds(timeout->seconds) + std::chrono::microseconds(timeout->microseconds));
        return 0;
    }
    timeval host{};
    host.tv_sec = static_cast<decltype(host.tv_sec)>(timeout->seconds);
    host.tv_usec = static_cast<decltype(host.tv_usec)>(timeout->microseconds);
    return ToGuestError(libusb_handle_events_timeout_completed(context, &host, nullptr));
}`, `#ifdef __APPLE__
std::int32_t APS5_VABI sceUsbdHandleEventsTimeout(const UsbdTimeval* timeout) {
    if (timeout == nullptr || timeout->seconds < 0 || timeout->microseconds < 0 || timeout->microseconds >= 1000000) return SCE_USBD_ERROR_INVALID_ARG;
    if (!ValidTimeout(timeout)) throw std::runtime_error(std::string(__func__) + ": a timeout of more than INT_MAX seconds is not supported");
    auto& events = Events();
    LockEventsAndClaim(events, __func__);
    const std::int32_t result = HandleEventsLocked(events, timeout);
    UnlockEventsAndRelease(events, __func__);
    return result;
}
#else
std::int32_t APS5_VABI sceUsbdHandleEventsTimeout(const UsbdTimeval* timeout) {
    if (timeout == nullptr || timeout->seconds < 0 || timeout->microseconds < 0 || timeout->microseconds >= 1000000) return SCE_USBD_ERROR_INVALID_ARG;
    libusb_context* context;
    {
        auto& state = State();
        std::lock_guard lock(state.mutex);
        context = state.context;
    }
    if (context == nullptr) {
        std::this_thread::sleep_for(std::chrono::seconds(timeout->seconds) + std::chrono::microseconds(timeout->microseconds));
        return 0;
    }
    timeval host{};
    host.tv_sec = static_cast<decltype(host.tv_sec)>(timeout->seconds);
    host.tv_usec = static_cast<decltype(host.tv_usec)>(timeout->microseconds);
    return ToGuestError(libusb_handle_events_timeout_completed(context, &host, nullptr));
}
#endif`],
    [`std::int32_t APS5_VABI sceUsbdEventHandlingOk() {
    return 1;
}`, `#ifdef __APPLE__
std::int32_t APS5_VABI sceUsbdEventHandlingOk() {
    return Events().handler.load() == std::this_thread::get_id() ? 1 : 0;
}
#else
std::int32_t APS5_VABI sceUsbdEventHandlingOk() {
    return 1;
}
#endif`],
    [`std::int32_t APS5_VABI sceUsbdEventHandlerActive() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}`, `#ifdef __APPLE__
std::int32_t APS5_VABI sceUsbdEventHandlerActive() {
    return Events().handler.load() != std::thread::id{} ? 1 : 0;
}
#else
std::int32_t APS5_VABI sceUsbdEventHandlerActive() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}
#endif`],
    [`std::int32_t APS5_VABI sceUsbdHandleEvents() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}`, `#ifdef __APPLE__
std::int32_t APS5_VABI sceUsbdHandleEvents() {
    auto& events = Events();
    LockEventsAndClaim(events, __func__);
    const std::int32_t result = HandleEventsLocked(events, nullptr);
    UnlockEventsAndRelease(events, __func__);
    return result;
}
#else
std::int32_t APS5_VABI sceUsbdHandleEvents() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}
#endif`],
    [`std::int32_t APS5_VABI sceUsbdHandleEventsLocked(UsbdTimeval* timeout) {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}`, `#ifdef __APPLE__
std::int32_t APS5_VABI sceUsbdHandleEventsLocked(UsbdTimeval* timeout) {
    if (!ValidTimeout(timeout)) throw std::runtime_error(std::string(__func__) + ": a negative or oversized timeout has no known result");
    auto& events = Events();
    RequireEventLock(events, __func__);
    return HandleEventsLocked(events, timeout);
}
#else
std::int32_t APS5_VABI sceUsbdHandleEventsLocked(UsbdTimeval* timeout) {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}
#endif`],
    [`void APS5_VABI sceUsbdLockEventWaiters() {
    NotImplemented_nid_no_patch(__func__);
}`, `#ifdef __APPLE__
void APS5_VABI sceUsbdLockEventWaiters() {
    AcquireEvents(Events(), __func__);
}
#else
void APS5_VABI sceUsbdLockEventWaiters() {
    NotImplemented_nid_no_patch(__func__);
}
#endif`],
    [`void APS5_VABI sceUsbdLockEvents() {
    NotImplemented_nid_no_patch(__func__);
}`, `#ifdef __APPLE__
void APS5_VABI sceUsbdLockEvents() {
    LockEventsAndClaim(Events(), __func__);
}
#else
void APS5_VABI sceUsbdLockEvents() {
    NotImplemented_nid_no_patch(__func__);
}
#endif`],
    [`std::int32_t APS5_VABI sceUsbdTryLockEvents() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}`, `#ifdef __APPLE__
std::int32_t APS5_VABI sceUsbdTryLockEvents() {
    auto& events = Events();
    const auto self = std::this_thread::get_id();
    if (events.owner.load() == self || !events.lock.try_lock()) return 1;
    if (events.handler.load() != std::thread::id{}) {
        events.lock.unlock();
        return 1;
    }
    events.owner.store(self);
    events.handler.store(self);
    return 0;
}
#else
std::int32_t APS5_VABI sceUsbdTryLockEvents() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}
#endif`],
    [`void APS5_VABI sceUsbdUnlockEventWaiters() {
    NotImplemented_nid_no_patch(__func__);
}`, `#ifdef __APPLE__
void APS5_VABI sceUsbdUnlockEventWaiters() {
    ReleaseEvents(Events(), __func__);
}
#else
void APS5_VABI sceUsbdUnlockEventWaiters() {
    NotImplemented_nid_no_patch(__func__);
}
#endif`],
    [`void APS5_VABI sceUsbdUnlockEvents() {
    NotImplemented_nid_no_patch(__func__);
}`, `#ifdef __APPLE__
void APS5_VABI sceUsbdUnlockEvents() {
    UnlockEventsAndRelease(Events(), __func__);
}
#else
void APS5_VABI sceUsbdUnlockEvents() {
    NotImplemented_nid_no_patch(__func__);
}
#endif`],
    [`std::int32_t APS5_VABI sceUsbdWaitForEvent(UsbdTimeval* timeout) {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}`, `#ifdef __APPLE__
std::int32_t APS5_VABI sceUsbdWaitForEvent(UsbdTimeval* timeout) {
    if (!ValidTimeout(timeout)) throw std::runtime_error(std::string(__func__) + ": a negative or oversized timeout has no known result");
    auto& events = Events();
    RequireEventLock(events, __func__);
    return WaitForChange(events, timeout);
}
#else
std::int32_t APS5_VABI sceUsbdWaitForEvent(UsbdTimeval* timeout) {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}
#endif`],
    [`    libusb_free_transfer(host);
    if (guest->callback`, `    libusb_free_transfer(host);
#ifdef __APPLE__
    Events().completions.fetch_add(1);
#endif
    if (guest->callback`],
    [`int MaxPacketSize(`, `#ifdef __APPLE__
libusb_context* CurrentContext() {
    auto& state = State();
    std::lock_guard lock(state.mutex);
    return state.context;
}
#endif

int MaxPacketSize(`]
  ]);
  return ["core/libs/prx/libkernel/Equeue/Equeue.cpp","core/libs/prx/libkernel/Equeue/src/Kqueue.cpp","core/libs/prx/libSceSysmodule/Export.cpp","core/libs/prx/libkernel/DirectMemory/Jit.cpp","core/libs/prx/libSceNet/Export.cpp","core/libs/prx/libScePad/Export.cpp","core/libs/prx/libSceUsbd/Export.cpp"];
}
