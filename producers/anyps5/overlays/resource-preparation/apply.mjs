import fs from 'node:fs/promises';
import path from 'node:path';
function replace(source,before,after){
 if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('AnyPS5 resource preparation source changed: '+before.slice(0,96));
 return source.replace(before,after);
}
export async function applyResourcePreparationOverlay(root){
 const base=path.join(root,'core/libs/prx/libSceAgcDriver/Graphics');
 const file=path.join(base,'src/ShaderResources.cpp');let source=await fs.readFile(file,'utf8');
 source=replace(source,'std::uint64_t TextureCacheBudget(const VkPhysicalDeviceMemoryProperties& memory) {',`#ifdef __APPLE__
namespace {
bool sharesSystemMemory(const VkPhysicalDeviceMemoryProperties& memory) {
    return memory.memoryHeapCount == 1 && (memory.memoryHeaps[0].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) != 0;
}
}
#endif

std::uint64_t TextureCacheBudget(const VkPhysicalDeviceMemoryProperties& memory) {
#ifdef __APPLE__
    if (sharesSystemMemory(memory)) return std::max<std::uint64_t>(1024ull << 20u, memory.memoryHeaps[0].size / 8u);
#endif`);
 source=replace(source,'    return std::max<std::uint64_t>(2048ull << 20u, budget > reserved ? budget - reserved : 0u);',`    const auto sampled = std::max<std::uint64_t>(2048ull << 20u, budget > reserved ? budget - reserved : 0u);
#ifdef __APPLE__
    if (sharesSystemMemory(memory)) return std::min(sampled, TextureCacheBudget(memory));
#endif
    return sampled;`);
 source=replace(source,'    return std::max<std::uint64_t>(512ull << 20u, std::min<std::uint64_t>(memory.memoryHeaps[*heap].size / 2u, reported->heapBudget[*heap] / 2u));',`    const auto ceiling = std::max<std::uint64_t>(512ull << 20u, std::min<std::uint64_t>(memory.memoryHeaps[*heap].size / 2u, reported->heapBudget[*heap] / 2u));
#ifdef __APPLE__
    if (sharesSystemMemory(memory)) return std::min(ceiling, TextureCacheBudget(memory));
#endif
    return ceiling;`);
 await fs.writeFile(file,source);
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * unified-memory texture-cache budget:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/743f29c63c748cc6f6b89df0db740702d622d4f1
 */
