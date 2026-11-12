import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Cannot locate the host buffer boundary: ${before.slice(0, 80)}`);
  return source.replace(before, after);
}

export async function applyBufferOverlay(root) {
  const location = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics/src/GuestBufferMemory.cpp');
  let source = await fs.readFile(location, 'utf8');
  source = replace(source,
    '            const HostImport* entry = region.direct != nullptr && state.epoch == importsEpoch ? region.direct : nullptr;', `#ifdef __APPLE__
            const auto* previous = region.direct;
            const bool covers = previous != nullptr && region.begin >= previous->base && region.end <= previous->base + previous->bytes;
            const HostImport* entry = covers && state.epoch == importsEpoch ? previous : nullptr;
#else
            const HostImport* entry = region.direct != nullptr && state.epoch == importsEpoch ? region.direct : nullptr;
#endif`);
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
  await fs.writeFile(location, source);
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * direct-import coverage validation:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/cb2727da290a76400f8a20534def4076cd362a5e
 */
