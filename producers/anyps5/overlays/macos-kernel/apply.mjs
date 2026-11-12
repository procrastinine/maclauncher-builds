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
    // Named objects are linked files in /tmp; anonymous objects follow the upstream unlinked temporary-file rule.
    source = replace(source, `    if (::fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode) || status.st_nlink != 0) return false;
    char objectPath[MAXPATHLEN];
    if (::fcntl(descriptor, F_GETPATH, objectPath) != 0) return false;
    const std::string_view path(objectPath);
`, `    if (::fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode)) return false;
    char objectPath[MAXPATHLEN];
    if (::fcntl(descriptor, F_GETPATH, objectPath) != 0) return false;
    const std::string_view path(objectPath);
    if (path.starts_with("/tmp/anyps5-shm-") || path.starts_with("/private/tmp/anyps5-shm-")) return true;
    if (status.st_nlink != 0) return false;
`);
    source = replace(source, '#ifdef __APPLE__\n    NotImplemented_nid_no_patch("shm_open");\n#endif\n', '');
    source = replace(source, '#ifdef __APPLE__\n    NotImplemented_nid_no_patch("shm_unlink");\n#endif\n', '');
    source = replace(source, '#ifdef __linux__\n        descriptor = ::open("/dev/shm", O_RDONLY | O_DIRECTORY | O_CLOEXEC);', '#if defined(__linux__) || defined(__APPLE__)\n#ifdef __APPLE__\n        descriptor = ::open("/tmp", O_RDONLY | O_DIRECTORY | O_CLOEXEC);\n#else\n        descriptor = ::open("/dev/shm", O_RDONLY | O_DIRECTORY | O_CLOEXEC);\n#endif');
    source = replace(source, '#ifdef __linux__\n        const int savedError = errno;', '#if defined(__linux__) || defined(__APPLE__)\n        const int savedError = errno;');
    source = source.replaceAll('::shm_open(', 'DarwinShmOpen(').replaceAll('::shm_unlink(', 'DarwinShmUnlink(');
    source = replace(source, '#ifdef __APPLE__\nstatic int DarwinShmOpen', '#ifndef __APPLE__\n#define DarwinShmOpen ::shm_open\n#define DarwinShmUnlink ::shm_unlink\n#endif\n\n#ifdef __APPLE__\nstatic int DarwinShmOpen');
    source = replace(source, '    const auto objectPath = "/dev/shm" + hostName;', '#ifdef __APPLE__\n    const auto objectPath = "/tmp" + hostName;\n#else\n    const auto objectPath = "/dev/shm" + hostName;\n#endif');
    return source;
  });
  await adapt(root, 'DirectMemory/DirectMemory.cpp', source => {
    source = replace(source, '        if (ArenaAvailable() && !GuestArena::GuestArenaContains_nid_postfix(addr, len))\n            throw std::invalid_argument("fixed mapping is outside the guest address space arena");\n        if (ArenaAvailable()) {', '#ifndef __APPLE__\n        if (ArenaAvailable() && !GuestArena::GuestArenaContains_nid_postfix(addr, len))\n            throw std::invalid_argument("fixed mapping is outside the guest address space arena");\n#endif\n        if (ArenaAvailable() && GuestArena::GuestArenaContains_nid_postfix(addr, len)) {');
    source = replace(source, 'void Unmap(void* addr, size_t len) {', 'void Unmap(void* addr, size_t len) {\n#ifdef __APPLE__\n    GuestWriteWatch::GuestWriteWatchUnregister_nid_postfix(addr, len);\n#endif');
    source = replace(source, '    ArenaForget(addr, len);\n    GuestWriteWatch::GuestWriteWatchUnregister_nid_postfix(addr, len);', '    ArenaForget(addr, len);\n#ifndef __APPLE__\n    GuestWriteWatch::GuestWriteWatchUnregister_nid_postfix(addr, len);\n#endif');
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
  await fs.copyFile(path.join(directory, 'DarwinThread.hpp'), path.join(kernelRoot, 'Pthread/include/DarwinThread.hpp'));
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * Apple guest-arena placement:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/90352825c5e49a8d84eeace9a2dd670da5ea81ab
 */
