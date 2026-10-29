import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

async function adapt(root, relative, transform) {
  const location = path.join(root, 'core/libs/prx/libkernel', relative);
  const original = await fs.readFile(location, 'utf8');
  const replacement = transform(original);
  if (replacement === original) throw new Error(`No Darwin adaptation applied to ${relative}`);
  await fs.writeFile(location, replacement);
}

function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Cannot locate Darwin adaptation boundary: ${before.slice(0, 80)}`);
  return source.replace(before, after);
}

export async function applyKernelOverlay(root) {
  await adapt(root, 'File/src/SharedMemory.cpp', source => {
    source = replace(source, 'namespace {\n', `#ifdef __APPLE__
static int DarwinShmOpen(const char* name, int flags, mode_t mode) {
    const auto path = std::string("/tmp") + name;
    const int descriptor = ::open(path.c_str(), flags | O_NOFOLLOW, mode);
    if (descriptor < 0) return descriptor;
    struct stat status{};
    const int statusResult = ::fstat(descriptor, &status);
    if (statusResult == 0 && S_ISREG(status.st_mode)) return descriptor;
    const int error = statusResult == 0 ? EINVAL : errno;
    ::close(descriptor);
    errno = error;
    return -1;
}

static int DarwinShmUnlink(const char* name) {
    return ::unlink((std::string("/tmp") + name).c_str());
}
#endif

namespace {
`);
    source = replace(source, '#elif defined(_WIN32)\n    {', `#elif defined(__APPLE__)
    char path[PATH_MAX];
    if (::fcntl(descriptor, F_GETPATH, path) != 0) return false;
    const std::string_view name(path);
    return name.starts_with("/tmp/anyps5-shm-") || name.starts_with("/private/tmp/anyps5-shm-");
#elif defined(_WIN32)
    {`);
    source = replace(source, '#include <unistd.h>\n#include <cstdio>', '#include <unistd.h>\n#include <limits.h>\n#include <cstdio>');
    source = replace(source, '#ifdef __linux__\n        descriptor = ::open("/dev/shm", O_RDONLY | O_DIRECTORY | O_CLOEXEC);', '#if defined(__linux__) || defined(__APPLE__)\n#ifdef __APPLE__\n        descriptor = ::open("/tmp", O_RDONLY | O_DIRECTORY | O_CLOEXEC);\n#else\n        descriptor = ::open("/dev/shm", O_RDONLY | O_DIRECTORY | O_CLOEXEC);\n#endif');
    source = replace(source, '#ifdef __linux__\n        const int savedError = errno;', '#if defined(__linux__) || defined(__APPLE__)\n        const int savedError = errno;');
    source = replace(source, '#else\n    const int descriptor = memfd_create("anyps5 shm_open", MFD_CLOEXEC);', `#elif defined(__APPLE__)
    char path[] = "/tmp/anyps5-shm-anon-XXXXXX";
    const int descriptor = ::mkstemp(path);
    if (descriptor < 0) return descriptor;
    const int savedError = errno;
    if (::unlink(path) != 0 || ::fcntl(descriptor, F_SETFD, FD_CLOEXEC) != 0) {
        const int error = errno;
        ::close(descriptor);
        ::unlink(path);
        errno = error;
        return -1;
    }
    errno = savedError;
    return descriptor;
#else
    const int descriptor = memfd_create("anyps5 shm_open", MFD_CLOEXEC);`);
    source = source.replaceAll('::shm_open(', 'DarwinShmOpen(').replaceAll('::shm_unlink(', 'DarwinShmUnlink(');
    source = replace(source, '#ifdef __APPLE__\nstatic int DarwinShmOpen', '#ifndef __APPLE__\n#define DarwinShmOpen ::shm_open\n#define DarwinShmUnlink ::shm_unlink\n#endif\n\n#ifdef __APPLE__\nstatic int DarwinShmOpen');
    source = replace(source, '    const auto objectPath = "/dev/shm" + hostName;', '#ifdef __APPLE__\n    const auto objectPath = "/tmp" + hostName;\n#else\n    const auto objectPath = "/dev/shm" + hostName;\n#endif');
    return source;
  });
  await adapt(root, 'File/src/Stdio.cpp', source => {
    source = replace(source, '    if (::fdatasync(fd) != 0) return SceErrorFromErrno(errno);', '#ifdef __APPLE__\n    if (::fsync(fd) != 0) return SceErrorFromErrno(errno);\n#else\n    if (::fdatasync(fd) != 0) return SceErrorFromErrno(errno);\n#endif');
    source = replace(source, '#include <sys/statvfs.h>\n#include <sys/vfs.h>', `#include <sys/statvfs.h>
#ifdef __APPLE__
#include <sys/mount.h>
#include <sys/param.h>
#else
#include <sys/vfs.h>
#endif`);
    source = replace(source, '    constexpr long PipeFilesystem = 0x50495045;', '#ifdef __APPLE__\n    struct stat file{};\n    return ::fstat(descriptor, &file) == 0 && S_ISFIFO(file.st_mode);\n#else\n    constexpr long PipeFilesystem = 0x50495045;');
    source = replace(source, '        && static_cast<long>(kind.f_type) == PipeFilesystem;\n}', '        && static_cast<long>(kind.f_type) == PipeFilesystem;\n#endif\n}');
    source = replace(source, '    if (S_ISSOCK(file.st_mode) && (::fcntl(descriptor, F_GETFL) & O_PATH) == 0) return GUEST_EINVAL;', '#ifdef __APPLE__\n    if (S_ISSOCK(file.st_mode)) return GUEST_EINVAL;\n#else\n    if (S_ISSOCK(file.st_mode) && (::fcntl(descriptor, F_GETFL) & O_PATH) == 0) return GUEST_EINVAL;\n#endif');
    source = replace(source, '    if (host.f_flag & ST_NOEXEC) fs->f_flags |= KERNEL_MNT_NOEXEC;', '#ifdef __APPLE__\n    struct statfs mount{};\n    if (::fstatfs(descriptor, &mount) != 0) return SceErrorFromErrno(errno) & 0xffff;\n    if (mount.f_flags & MNT_NOEXEC) fs->f_flags |= KERNEL_MNT_NOEXEC;\n#else\n    if (host.f_flag & ST_NOEXEC) fs->f_flags |= KERNEL_MNT_NOEXEC;\n#endif');
    source = replace(source, 'static unsigned char GuestEntryType(int fd, const struct dirent64& entry, bool followLinks)', '#ifdef __APPLE__\nusing HostDirectoryEntry = dirent;\n#else\nusing HostDirectoryEntry = dirent64;\n#endif\n\nstatic unsigned char GuestEntryType(int fd, const HostDirectoryEntry& entry, bool followLinks)');
    source = replace(source, '    const auto read = ::syscall(SYS_getdents64, fd, host.data(), host.size());', '#ifdef __APPLE__\n    off_t hostBase = base;\n    const auto read = ::syscall(SYS_getdirentries64, fd, host.data(), host.size(), &hostBase);\n#else\n    const auto read = ::syscall(SYS_getdents64, fd, host.data(), host.size());\n#endif');
    source = replace(source, 'reinterpret_cast<const struct dirent64*>(host.data() + offset)', 'reinterpret_cast<const HostDirectoryEntry*>(host.data() + offset)');
    source = replace(source, '        resume = entry->d_off;', '#ifdef __APPLE__\n        resume = static_cast<off_t>(entry->d_seekoff);\n#else\n        resume = entry->d_off;\n#endif');
    source = replace(source, '    const off_t base = ::lseek(fd, 0, SEEK_CUR);', '#ifdef __APPLE__\n    return File::ReadDirectoryDescriptor(fd, buf, nbytes, basep);\n#else\n    const off_t base = ::lseek(fd, 0, SEEK_CUR);');
    source = replace(source, '    return static_cast<int>(written);\n}\n\nint APS5_VABI sceKernelGetdents', '    return static_cast<int>(written);\n#endif\n}\n\nint APS5_VABI sceKernelGetdents');
    return source;
  });
  await adapt(root, 'File/src/DirectoryDescriptor.cpp', source => {
    source = '#ifdef __APPLE__\n#include <limits.h>\n#endif\n' + source;
    source = replace(source, '    if (g_directoryCount.load(std::memory_order_relaxed) == 0) return nullptr;\n    std::lock_guard lock(g_mutex);\n    const auto found = g_directories.find(fd);\n    return found == g_directories.end() ? nullptr : found->second;', `#ifndef __APPLE__
    if (g_directoryCount.load(std::memory_order_relaxed) == 0) return nullptr;
#endif
    std::lock_guard lock(g_mutex);
    const auto found = g_directories.find(fd);
    if (found != g_directories.end()) return found->second;
#ifdef __APPLE__
    struct stat status{};
    char nativePath[PATH_MAX];
    if (::fstat(fd, &status) != 0 || !S_ISDIR(status.st_mode) || ::fcntl(fd, F_GETPATH, nativePath) != 0) return nullptr;
    auto state = std::make_shared<DirectoryState>();
    state->path = std::filesystem::path(nativePath);
    state->nativeBacked = true;
    g_directories.emplace(fd, state);
    g_directoryCount.store(g_directories.size(), std::memory_order_relaxed);
    return state;
#else
    return nullptr;
#endif`);
    // Keep the upstream shared directory state, archive merge and guest inode mapping.
    source = replace(source, '        std::error_code error;\n        const auto link = std::filesystem::path("/proc/self/fd")', '#ifdef __APPLE__\n        char nativePath[PATH_MAX];\n        if (::fcntl(fd, F_GETPATH, nativePath) != 0) return std::nullopt;\n        return std::filesystem::path(nativePath);\n#else\n        std::error_code error;\n        const auto link = std::filesystem::path("/proc/self/fd")');
    source = replace(source, '        return target;\n#endif\n    }', '        return target;\n#endif\n#endif\n    }');
    source = replace(source, '#ifdef _WIN32\n    return std::nullopt;\n#else\n    if (fd < 0)', '#ifdef _WIN32\n    return std::nullopt;\n#elif defined(__APPLE__)\n    return std::nullopt;\n#else\n    if (fd < 0)');
    source = replace(source, '        const bool followLinks = InsideApp0(directoryPath);\n        errno = savedErrno;\n#endif', `        const bool followLinks = InsideApp0(directoryPath);
        errno = savedErrno;
#elif defined(__APPLE__)
        std::error_code linkError;
        const auto app0 = std::filesystem::weakly_canonical(ResolveDiskPath_nid_no_patch("/app0"), linkError);
        const auto relative = directoryPath.lexically_relative(app0);
        const bool followLinks = !linkError && !app0.empty() && !relative.empty() && *relative.begin() != "..";
#endif`);
    source = replace(source, '            Add(state, name, static_cast<std::uint64_t>(entryStatus.st_ino), DirectoryEntryType(it->symlink_status(error)));', `            auto type = DirectoryEntryType(it->symlink_status(error));
#ifdef __APPLE__
            if (!error && followLinks && type == GuestSymbolicLinkType) {
                const int savedErrno = errno;
                FileStat target{};
                if (File::TryFillFileStat(it->path(), &target)) {
                    if ((target.st_mode & 0170000) == 0040000) type = GuestDirectoryType;
                    else if ((target.st_mode & 0170000) == 0100000) type = GuestRegularType;
                }
                errno = savedErrno;
            }
#endif
            Add(state, name, static_cast<std::uint64_t>(entryStatus.st_ino), type);`);
    source = replace(source, 'void DuplicateDirectoryDescriptor(int from, int to) {', 'void DuplicateDirectoryDescriptor(int from, int to) {\n#ifdef __APPLE__\n    (void)Find(from);\n#endif');
    return source;
  });
  await adapt(root, 'DirectMemory/DirectMemory.cpp', source => {
    source = source.replaceAll('#if defined(__linux__)\n', '#if defined(__linux__) || defined(__APPLE__)\n');
    source = replace(source, '#include <link.h>', '#ifdef __APPLE__\n#include "prx/libc/include/specifics/linux/ElfTypes.hpp"\n#include "DarwinMemory.hpp"\n#else\n#include <link.h>\n#endif');
    source = replace(source, 'static void MapUnmappedPages(void* addr, size_t len) {', 'static void MapUnmappedPages(void* addr, size_t len) {\n#ifdef __APPLE__\n    DarwinMemory::MapUnmappedPages(addr, len);\n#else');
    source = replace(source, '        cursor += bytes;\n    }\n}\n#endif\n\nnamespace {', '        cursor += bytes;\n    }\n#endif\n}\n#endif\n\nnamespace {');
    source = replace(source, 'void* MapAtOrAbove(std::uintptr_t start, size_t len, int prot, size_t alignment) {', 'void* MapAtOrAbove(std::uintptr_t start, size_t len, int prot, size_t alignment) {\n#ifdef __APPLE__\n    return DarwinMemory::MapAtOrAbove(start, len, prot, alignment);\n#else');
    source = replace(source, '    throw std::runtime_error("Hinted mmap kept racing with other mappings");\n}', '    throw std::runtime_error("Hinted mmap kept racing with other mappings");\n#endif\n}');
    source = replace(source, 'int PhysicalFile() {\n    static const int file = [] {', 'int PhysicalFile() {\n#ifdef __APPLE__\n    static const int file = DarwinMemory::PhysicalFile(DIRECT_MEMORY_SIZE);\n#else\n    static const int file = [] {');
    source = replace(source, '        return created;\n    }();\n    return file;', '        return created;\n    }();\n#endif\n    return file;');
    source = replace(source, '        const int placement = (flags & GuestMapNoOverwrite) != 0 ? MAP_FIXED_NOREPLACE : MAP_FIXED;', '#ifdef __APPLE__\n        const int placement = MAP_FIXED;\n#else\n        const int placement = (flags & GuestMapNoOverwrite) != 0 ? MAP_FIXED_NOREPLACE : MAP_FIXED;\n#endif');
    source = replace(source, '        void* result = mmap(addr, len, prot, MAP_PRIVATE | MAP_ANONYMOUS | placement, -1, 0);', '#ifdef __APPLE__\n        void* result = (flags & GuestMapNoOverwrite) != 0 ? DarwinMemory::MapNoReplace(addr, len, prot) :\n            mmap(addr, len, prot, MAP_PRIVATE | MAP_ANONYMOUS | placement, -1, 0);\n#else\n        void* result = mmap(addr, len, prot, MAP_PRIVATE | MAP_ANONYMOUS | placement, -1, 0);\n#endif');
    return source;
  });
  await adapt(root, 'Pthread/include/Pthread.hpp', source => replace(source, '    clockid_t hostCpuClock{};', '#ifdef __APPLE__\n    pthread_t hostCpuThread{};\n#else\n    clockid_t hostCpuClock{};\n#endif'));
  await adapt(root, 'Pthread/src/Thread.cpp', source => {
    source = '#ifdef __APPLE__\n#include "prx/libkernel/Pthread/include/DarwinThread.hpp"\n#endif\n' + source;
    source = replace(source, '        pthread_attr_t attr;\n        if (pthread_getattr_np', '#ifdef __APPLE__\n        const auto thread = pthread_self();\n        const auto size = pthread_get_stacksize_np(thread);\n        stackHigh = reinterpret_cast<std::uintptr_t>(pthread_get_stackaddr_np(thread));\n        if (size == 0 || stackHigh < size) return false;\n        stackLow = stackHigh - size;\n#else\n        pthread_attr_t attr;\n        if (pthread_getattr_np');
    source = replace(source, '        stackHigh = stackLow + size;\n    }', '        stackHigh = stackLow + size;\n#endif\n    }');
    source = replace(source, '    (void)self;\n#else\n    clockid_t clock{};', '    (void)self;\n#elif defined(__APPLE__)\n    auto& registry = CpuClocks();\n    std::lock_guard lock(registry.lock);\n    self->hostCpuThread = pthread_self();\n    self->hostCpuClockBound = true;\n#else\n    clockid_t clock{};');
    source = replace(source, '    struct timespec time{};\n    if (clock_gettime(thread->hostCpuClock, &time) != 0)', '#ifdef __APPLE__\n    thread_basic_info_data_t time{};\n    if (!DarwinThread::CpuTime(thread->hostCpuThread, time)) return false;\n    *nanos = DarwinThread::CpuNanos(time);\n#else\n    struct timespec time{};\n    if (clock_gettime(thread->hostCpuClock, &time) != 0)');
    source = replace(source, '    *nanos = static_cast<std::uint64_t>(time.tv_sec) * 1000000000ULL + static_cast<std::uint64_t>(time.tv_nsec);', '    *nanos = static_cast<std::uint64_t>(time.tv_sec) * 1000000000ULL + static_cast<std::uint64_t>(time.tv_nsec);\n#endif');
    return source;
  });
  await adapt(root, 'System/src/Process.cpp', source => {
    source = '#ifdef __APPLE__\n#include "prx/libkernel/Pthread/include/DarwinThread.hpp"\n#endif\n' + source;
    source = replace(source, '#else\n    const int cpu = ::sched_getcpu();', '#elif defined(__APPLE__)\n    std::size_t cpu = 0;\n    if (const int error = ::pthread_cpu_number_np(&cpu); error != 0)\n        throw std::system_error(error, std::generic_category(), "Reading current processor");\n    const auto index = static_cast<unsigned>(cpu);\n#else\n    const int cpu = ::sched_getcpu();');
    source = replace(source, '    if (::getrusage(who == 0 ? RUSAGE_SELF : RUSAGE_THREAD, &native) != 0)\n        throw std::system_error(errno, std::generic_category(), "getrusage: getrusage failed");', '#ifdef __APPLE__\n    if (who == 1) {\n        thread_basic_info_data_t time{};\n        if (!DarwinThread::CpuTime(pthread_self(), time)) throw std::runtime_error("getrusage: current thread is unavailable");\n        native.ru_utime.tv_sec = time.user_time.seconds;\n        native.ru_utime.tv_usec = time.user_time.microseconds;\n        native.ru_stime.tv_sec = time.system_time.seconds;\n        native.ru_stime.tv_usec = time.system_time.microseconds;\n    } else if (::getrusage(RUSAGE_SELF, &native) != 0) {\n        throw std::system_error(errno, std::generic_category(), "getrusage: process usage is unavailable");\n    }\n#else\n    if (::getrusage(who == 0 ? RUSAGE_SELF : RUSAGE_THREAD, &native) != 0)\n        throw std::system_error(errno, std::generic_category(), "getrusage: getrusage failed");\n#endif');
    source = replace(source, '    result.ru_maxrss = static_cast<std::int64_t>(native.ru_maxrss);', '#ifdef __APPLE__\n    result.ru_maxrss = static_cast<std::int64_t>(native.ru_maxrss / 1024);\n#else\n    result.ru_maxrss = static_cast<std::int64_t>(native.ru_maxrss);\n#endif');
    return source;
  });
  const kernelRoot = path.join(root, 'core/libs/prx/libkernel');
  await fs.copyFile(path.join(directory, 'DarwinMemory.hpp'), path.join(kernelRoot, 'DirectMemory/DarwinMemory.hpp'));
  await fs.copyFile(path.join(directory, 'DarwinThread.hpp'), path.join(kernelRoot, 'Pthread/include/DarwinThread.hpp'));
}
