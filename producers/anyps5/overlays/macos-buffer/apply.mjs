import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Cannot locate the host buffer boundary: ${before.slice(0, 80)}`);
  return source.replace(before, after);
}

export async function applyBufferOverlay(root) {
  const location = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics/src/GuestBufferMemory.cpp');
  let source = await fs.readFile(location, 'utf8');
  source = replace(source, '#include <linux/udmabuf.h>', '#ifdef __linux__\n#include <linux/udmabuf.h>\n#endif\n#ifdef __APPLE__\n#include <sys/sysctl.h>\n#endif');
  for (const boundary of ['struct ImportFamilies {', '    ImportFamilies families;', 'int udmabufDevice() {', 'constexpr std::uint64_t ImportChunkBytes', 'struct BackingFile {', '    BackingFile backing;', '    if (BackingFile backing;']) {
    source = replace(source, '#ifndef _WIN32\n' + boundary, '#ifdef __linux__\n' + boundary);
  }
  source = replace(source, '#else\n    const auto watching = importWatching(context, state, false, true, run.bytes);\n    BackingFile backing;', '#elif defined(__APPLE__)\n    return importWatching(context, state, false, true, run.bytes).hostPointer;\n#else\n    const auto watching = importWatching(context, state, false, true, run.bytes);\n    BackingFile backing;');
  source = replace(source, 'const char* createHostPointerImport(const Context& context, HostImport& entry, VkResult& failure) {\n    void* const host', `const char* createHostPointerImport(const Context& context, HostImport& entry, VkResult& failure) {
#ifdef __APPLE__
    if (context.hostImportAlignment == 0) {
        failure = VK_ERROR_EXTENSION_NOT_PRESENT;
        return "host memory import support";
    }
#endif
    void* const host`);
  source = replace(source, '    VkMemoryHostPointerPropertiesEXT pointer{VK_STRUCTURE_TYPE_MEMORY_HOST_POINTER_PROPERTIES_EXT};', `#ifdef __APPLE__
    if (entry.bytes == 0 || reinterpret_cast<std::uintptr_t>(host) % context.hostImportAlignment != 0 || entry.bytes % context.hostImportAlignment != 0) {
        failure = VK_ERROR_INVALID_EXTERNAL_HANDLE;
        return "host memory import alignment";
    }
#endif
    VkMemoryHostPointerPropertiesEXT pointer{VK_STRUCTURE_TYPE_MEMORY_HOST_POINTER_PROPERTIES_EXT};`);
  source = replace(source, '    return GlobalMemoryStatusEx(&status) ? status.ullTotalPhys : 0;\n#else', '    return GlobalMemoryStatusEx(&status) ? status.ullTotalPhys : 0;\n#elif defined(__APPLE__)\n    std::uint64_t bytes = 0;\n    std::size_t length = sizeof(bytes);\n    return ::sysctlbyname("hw.memsize", &bytes, &length, nullptr, 0) == 0 ? bytes : 0;\n#else');
  source = replace(source, 'ImportProbe ProbeDmaBufImportWriteProtection(const Context& context) {\n    ImportProbe probe;\n#ifdef _WIN32\n    static_cast<void>(context);\n    probe.failure = "the Linux write watch";', 'ImportProbe ProbeDmaBufImportWriteProtection(const Context& context) {\n    ImportProbe probe;\n#ifndef __linux__\n    static_cast<void>(context);\n    probe.failure = "DMA-BUF import requires Linux";');
  await fs.writeFile(location, source);
}
