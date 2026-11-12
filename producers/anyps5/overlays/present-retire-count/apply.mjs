// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

const driverRoot = 'core/libs/prx/libSceAgcDriver';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 present GPU accounting source changed: ' + before.slice(0, 100));
  return source.replace(before, after);
}

async function edit(root, file, change) {
  const target = path.join(root, file);
  await fs.writeFile(target, change(await fs.readFile(target, 'utf8')));
}

// The [present] line's and the trace summary's GPU busy time add up the batch timestamps of the
// batches each retired blit waited for. A batch reaped as soon as its fence signaled (queue 0's
// completion poll does that within a millisecond) can find its timestamp results not yet available;
// it then kept no time, and a title whose frame is one such batch (DOOM's compute presentation)
// showed no GPU time at all. Such a batch's timestamp pool now moves to its completion record, and
// the present's retire, which runs after the blit's fence wait, reads it there and counts the batch
// (the [present] line names how many). Batch stamps exist only while a profile or trace asks for them.
export async function applyPresentRetireCountOverlay(root) {
  await edit(root, driverRoot + '/Graphics/include/Recorder.hpp', source => {
    source = replace(source,
      '    struct Completed {\n        std::uint64_t serial = 0;\n',
      '    struct Completed {\n        std::uint64_t serial = 0;\n' +
      '        // The batch\'s timestamp pool when its results were not ready at its finish; the next\n' +
      '        // CompletedBatches over it reads them (and frees the pool), under the ring mutex.\n' +
      '        VkQueryPool lateStamps = VK_NULL_HANDLE;\n');
    source = replace(source,
      '    std::vector<Completed> CompletedBatches(std::uint64_t afterSerial, std::uint64_t throughSerial, std::size_t& missing) const;\n',
      '    std::vector<Completed> CompletedBatches(std::uint64_t afterSerial, std::uint64_t throughSerial, std::size_t& missing) const;\n' +
      '    // batches whose timestamps CompletedBatches read after their finish, in total;\n' +
      '    static std::uint64_t LateStampsRead();\n');
    source = replace(source,
      '        VkFence fence = VK_NULL_HANDLE;\n',
      '        VkFence fence = VK_NULL_HANDLE;\n        // the batch timestamps were not available when the batch finished;\n        bool stampsLate = false;\n');
    source = replace(source,
      '    void readGpuTiming(Batch& batch);\n',
      '    void readGpuTiming(Batch& batch);\n    void resolveLateStamps(Completed& entry);\n');
    return source;
  });

  await edit(root, driverRoot + '/Graphics/src/Recorder.cpp', source => {
    source = replace(source,
      'std::atomic<std::uint64_t> completionLabelsCountedLate{0};\n',
      'std::atomic<std::uint64_t> completionLabelsCountedLate{0};\n' +
      'std::atomic<std::uint64_t> lateStampsRead{0};\n');
    source = replace(source,
      '    if (result != VK_SUCCESS) return;\n    const auto period = context.limits.timestampPeriod;\n    if (!GpuTimingEnabled()) {\n',
      '    if (result != VK_SUCCESS) {\n' +
      '        if (result == VK_NOT_READY && !GpuTimingEnabled() && batch.batchTiming == 0) batch.stampsLate = true;\n' +
      '        return;\n' +
      '    }\n' +
      '    const auto period = context.limits.timestampPeriod;\n    if (!GpuTimingEnabled()) {\n');
    source = replace(source,
      '        auto& entry = completed[batch->serial % completed.size()];\n        entry.serial = batch->serial;\n',
      '        auto& entry = completed[batch->serial % completed.size()];\n' +
      '        if (entry.lateStamps != VK_NULL_HANDLE) context.Function<PFN_vkDestroyQueryPool>("vkDestroyQueryPool")(context.device, entry.lateStamps, nullptr);\n' +
      '        entry.lateStamps = batch->stampsLate ? std::exchange(batch->queries, VK_NULL_HANDLE) : VK_NULL_HANDLE;\n' +
      '        entry.serial = batch->serial;\n');
    source = replace(source,
      '    for (auto serial = afterSerial + 1; serial <= throughSerial; ++serial) {\n        const auto& entry = completed[serial % completed.size()];\n        if (entry.serial == serial) found.push_back(entry);\n',
      '    for (auto serial = afterSerial + 1; serial <= throughSerial; ++serial) {\n' +
      '        // The ring is this recorder\'s own (never a const object); a late timestamp read fills its entry.\n' +
      '        auto& entry = const_cast<Completed&>(completed[serial % completed.size()]);\n' +
      '        if (entry.serial == serial && entry.lateStamps != VK_NULL_HANDLE) const_cast<Recorder*>(this)->resolveLateStamps(entry);\n' +
      '        if (entry.serial == serial) found.push_back(entry);\n');
    source = replace(source,
      'std::uint64_t Recorder::NewestSubmitted(std::chrono::steady_clock::time_point* submittedAt) const {\n',
      '// Under the ring mutex: the batch\'s two stamps when its pool has them now; a pool still not ready\n' +
      '// stays for a later read (or is freed when the entry is reused or the recorder is destroyed).\n' +
      'void Recorder::resolveLateStamps(Completed& entry) {\n' +
      '    std::uint64_t stamps[2] = {};\n' +
      '    const auto result = context.Function<PFN_vkGetQueryPoolResults>("vkGetQueryPoolResults")(context.device, entry.lateStamps, 0, 2, sizeof(stamps), stamps, sizeof(std::uint64_t), VK_QUERY_RESULT_64_BIT);\n' +
      '    if (result == VK_NOT_READY) return;\n' +
      '    if (result == VK_SUCCESS && stamps[1] >= stamps[0]) {\n' +
      '        const auto period = context.limits.timestampPeriod;\n' +
      '        entry.gpuStartNs = static_cast<double>(stamps[0]) * period;\n' +
      '        entry.gpuEndNs = static_cast<double>(stamps[1]) * period;\n' +
      '        lateStampsRead.fetch_add(1, std::memory_order_relaxed);\n' +
      '    }\n' +
      '    context.Function<PFN_vkDestroyQueryPool>("vkDestroyQueryPool")(context.device, entry.lateStamps, nullptr);\n' +
      '    entry.lateStamps = VK_NULL_HANDLE;\n' +
      '}\n\n' +
      'std::uint64_t Recorder::LateStampsRead() {\n' +
      '    return lateStampsRead.load(std::memory_order_relaxed);\n' +
      '}\n\n' +
      'std::uint64_t Recorder::NewestSubmitted(std::chrono::steady_clock::time_point* submittedAt) const {\n');
    return replace(source,
      '    for (const auto pool : sparePools) context.Function<PFN_vkDestroyQueryPool>("vkDestroyQueryPool")(context.device, pool, nullptr);\n    sparePools.clear();\n',
      '    for (const auto pool : sparePools) context.Function<PFN_vkDestroyQueryPool>("vkDestroyQueryPool")(context.device, pool, nullptr);\n    sparePools.clear();\n' +
      '    for (auto& entry : completed) {\n' +
      '        if (entry.lateStamps != VK_NULL_HANDLE) context.Function<PFN_vkDestroyQueryPool>("vkDestroyQueryPool")(context.device, entry.lateStamps, nullptr);\n' +
      '        entry.lateStamps = VK_NULL_HANDLE;\n' +
      '    }\n');
  });

  await edit(root, driverRoot + '/Execution/include/VulkanDevice.hpp', source => replace(source,
    '        std::uint64_t presents, gpuUnread, batchesAheadOfBlit, batchesAfterFlip, readsChecked, readsOverwritten, acquireDrops, planes, keyWriterWaits;\n',
    '        // lateStamped: batches of those ranges whose timestamps were read at the retire (Recorder::LateStampsRead).\n' +
    '        std::uint64_t presents, gpuUnread, batchesAheadOfBlit, batchesAfterFlip, readsChecked, readsOverwritten, acquireDrops, planes, keyWriterWaits, lateStamped;\n'));

  await edit(root, driverRoot + '/Execution/src/VulkanDevice.cpp', source => replace(source,
    '            const auto batches = recorder->CompletedBatches(range.afterSerial, range.throughSerial, missing);\n',
    '            const auto lateBefore = Graphics::Recorder::LateStampsRead();\n' +
    '            const auto batches = recorder->CompletedBatches(range.afterSerial, range.throughSerial, missing);\n' +
    '            presentCounters.lateStamped += Graphics::Recorder::LateStampsRead() - lateBefore;\n'));

  await edit(root, driverRoot + '/Execution/src/Driver/Presentation.cpp', source => {
    source = replace(source, '(%llu batches without a completion record)', '(%llu batches without a completion record, %llu timed at the retire)');
    return replace(source,
      'static_cast<unsigned long long>(counts.gpuUnread - previous.gpuUnread), ',
      'static_cast<unsigned long long>(counts.gpuUnread - previous.gpuUnread), static_cast<unsigned long long>(counts.lateStamped - previous.lateStamped), ');
  });
}
