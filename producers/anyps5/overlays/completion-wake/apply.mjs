// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

const driverRoot = 'core/libs/prx/libSceAgcDriver';
const execution = driverRoot + '/Execution';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 completion wake source changed: ' + before.slice(0, 100));
  return source.replace(before, after);
}

async function edit(root, file, change) {
  const target = path.join(root, file);
  await fs.writeFile(target, change(await fs.readFile(target, 'utf8')));
}

export const watchdogSource = `
namespace AgcDriver::DriverDetail {

bool Driver::boundedIdleWait() {
    static const bool enabled = std::getenv("APS5_NO_BOUNDED_IDLE_WAIT") == nullptr;
    return enabled;
}

void Driver::startQueueWatchdog() {
    // A completion counted outside a queue worker's packet (a CPU write-back over a GPU-stored
    // completion label, a deferred action appended by another queue) wakes queue 0's idle worker so
    // its reap lands the label or interrupt without waiting for the next submission. The notify takes
    // no driver mutex (the caller may hold GpuMutex, which other paths take inside the driver mutex);
    // queue 0's bounded idle wait covers a notify that races its predicate check.
    Graphics::Recorder::SetCompletionWake([] { Get().changed.notify_all(); });
    queueWatchdog = std::jthread([this](std::stop_token stop) { watchQueueZero(stop); });
}

void Driver::stopQueueWatchdog() {
    Graphics::Recorder::SetCompletionWake(nullptr);
    queueWatchdog.request_stop();
    if (queueWatchdog.joinable()) queueWatchdog.join();
}

// Queue-0 stall report (APS5_QUEUE_WATCHDOG_MS, default 5000; 0 turns it off): see QueueStallWatch.
void Driver::watchQueueZero(std::stop_token stop) {
    static const long thresholdMs = [] {
        const char* text = std::getenv("APS5_QUEUE_WATCHDOG_MS");
        return text ? std::atol(text) : 5000L;
    }();
    if (thresholdMs <= 0) return;
    // The worker map and its deques are read only while the driver mutex is free; a busy mutex keeps
    // the previous packet, so a mutex held through the threshold reports as a stall too.
    const auto queuePacket = [&](std::uint64_t& packet) {
        std::unique_lock lock(mutex, std::try_to_lock);
        if (!lock.owns_lock()) return false;
        const auto found = workers.find(0);
        packet = found == workers.end() ? 0 : found->second.executingPacket.load(std::memory_order_relaxed);
        return true;
    };
    std::uint64_t packet = 0;
    queuePacket(packet);
    QueueStallWatch watch(std::chrono::milliseconds(thresholdMs), queue0Submissions.load(std::memory_order_relaxed), packet, std::chrono::steady_clock::now());
    auto holdAtStart = GuestMemory::GpuHolder().holdSerial;
    while (!stop.stop_requested()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        const auto now = std::chrono::steady_clock::now();
        const bool driverMutexFree = queuePacket(packet);
        const auto state = queue0WaitState.load(std::memory_order_relaxed);
        const auto interrupts = deferredInterrupts.load(std::memory_order_relaxed) - deferredInterruptsRun.load(std::memory_order_relaxed);
        const auto labelSince = Graphics::Recorder::PendingLabelSince();
        const auto recorded = Graphics::Recorder::RecordedWorkSinceSubmit();
        const auto batches = Graphics::Recorder::LiveBatches();
        const bool pending = completionsPending() || interrupts != 0 || labelSince.has_value() || recorded != 0 || batches != 0 || state == QueueWaitActive;
        if (!watch.Observe(queue0Submissions.load(std::memory_order_relaxed), packet, pending, now)) {
            if (watch.Moved()) holdAtStart = GuestMemory::GpuHolder().holdSerial;
            continue;
        }
        static constexpr const char* states[] = {"outside any wait (running a packet or between waits)", "in the untimed condition wait", "in the bounded 2 ms idle wait", "polling for completions"};
        const auto holder = GuestMemory::GpuHolder();
        char holderText[320];
        if (holder.tag == GuestMemory::NoGpuHolder) {
            std::snprintf(holderText, sizeof(holderText), "GpuMutex free");
        } else {
            char who[32];
            if (holder.tag == 0xffffffffu) std::snprintf(who, sizeof(who), "an untagged thread");
            else if (holder.tag == GuestMemory::PresenterGpuHolder) std::snprintf(who, sizeof(who), "the presenter");
            else std::snprintf(who, sizeof(who), "queue worker 0x%x", holder.tag);
            const char* symbol = nullptr;
            unsigned long long symbolOffset = 0;
#ifndef _WIN32
            Dl_info info{};
            if (holder.caller != nullptr && dladdr(holder.caller, &info) != 0 && info.dli_sname != nullptr) {
                symbol = info.dli_sname;
                symbolOffset = reinterpret_cast<std::uintptr_t>(holder.caller) - reinterpret_cast<std::uintptr_t>(info.dli_saddr);
            }
#endif
            std::snprintf(holderText, sizeof(holderText), "GpuMutex held by %s (thread id %llu), taken at site '%s' from %s+0x%llx (code 0x%llx), %s", who, static_cast<unsigned long long>(holder.thread), GuestMemory::GpuLockSiteName(holder.site),
                          symbol != nullptr ? symbol : "?", symbolOffset, GuestMemory::CodeOffset(holder.caller), holder.holdSerial == holdAtStart ? "the same hold since queue 0 stopped" : "a hold taken after queue 0 stopped");
        }
        std::string queues;
        {
            std::unique_lock lock(mutex, std::try_to_lock);
            if (lock.owns_lock()) {
                for (const auto& [id, worker] : workers) {
                    const auto executing = worker.executingPacket.load(std::memory_order_relaxed);
                    char text[112];
                    if (executing == 0) std::snprintf(text, sizeof(text), " queue 0x%x: no packet since its last dequeue, %zu pending;", id, worker.pending.size());
                    else std::snprintf(text, sizeof(text), " queue 0x%x: opcode 0x%02llx at dword %llu, %zu pending;", id, static_cast<unsigned long long>(executing & 0xffu), static_cast<unsigned long long>((executing >> 8u) - 1u), worker.pending.size());
                    queues += text;
                }
            } else {
                queues = " (driver mutex busy)";
            }
        }
        std::fprintf(stderr, "[watchdog] queue 0 has not moved for %.1f s: worker %s, %llu idle GpuMutex try-locks failed in a row (%llu in total); %s; driver mutex %s; pending: %llu completion labels and actions, %llu completion stores, %llu write-back completions, %llu deferred end-of-pipe interrupts, %llu labels counted late at CPU write-backs (in total), open label for %.1f ms, %llu dispatches and draws recorded since the last submit, %llu batches alive; last packets:%s\\n",
                     watch.StalledSeconds(now), state < std::size(states) ? states[state] : "in an unknown state",
                     static_cast<unsigned long long>(idleTryFailStreak.load(std::memory_order_relaxed)), static_cast<unsigned long long>(triesFailed[TryIdle].load(std::memory_order_relaxed)),
                     holderText, driverMutexFree ? "free" : "busy",
                     static_cast<unsigned long long>(Graphics::Recorder::PendingCompletionLabels()), static_cast<unsigned long long>(Graphics::Recorder::PendingCompletionStores()),
                     static_cast<unsigned long long>(Graphics::Recorder::PendingWriteBackCompletions()), static_cast<unsigned long long>(interrupts),
                     static_cast<unsigned long long>(Graphics::Recorder::CompletionLabelsCountedLate()),
                     labelSince ? std::chrono::duration<double, std::milli>(now - *labelSince).count() : 0.0,
                     static_cast<unsigned long long>(recorded), static_cast<unsigned long long>(batches), queues.c_str());
    }
}

}
`;

// Queue 0's idle worker reaps completion labels and deferred end-of-pipe interrupts while any are
// pending, but it slept without a time limit when none were pending as it went idle, and a completion
// counted afterwards outside a queue packet sent no wake: the label or interrupt waited for the next
// submission while the title waited for that label or interrupt. The recorder now wakes queue 0 when
// a CPU write-back counts a completion label late or a deferred action is appended, and queue 0 waits
// at most 2 ms while recorded batches exist (APS5_NO_BOUNDED_IDLE_WAIT=1 restores the untimed wait).
// A watchdog thread reports a queue-0 stall once (see watchQueueZero). GpuMutex records its outermost
// holder, the lock site and the calling code address at acquisition for that report.
export async function applyCompletionWakeOverlay(root) {
  await fs.copyFile(path.join(import.meta.dirname, 'QueueStallWatch.hpp'), path.join(root, execution, 'include/Driver/Queues/QueueStallWatch.hpp'));

  await edit(root, execution + '/include/GuestMemory.hpp', source => replace(source,
    'GpuMutexType& GpuMutex();\n',
    'GpuMutexType& GpuMutex();\n' +
    '// The outermost GpuMutex holder, for stall reports (the queue-0 watchdog): its queue tag\n' +
    '// (GpuLockThreadTag; PresenterGpuHolder for the presenter, NoGpuHolder while the mutex is free),\n' +
    '// the lock site named before the acquisition (TagGpuLockSite; try for an untagged try_lock), the\n' +
    '// code address that took it, its thread id and the hold serial (GpuHoldSerial), which stays the\n' +
    '// same while one hold lasts. Read without the mutex, so the fields of two holds may mix.\n' +
    'constexpr std::uint32_t NoGpuHolder = 0xfffffffcu;\n' +
    'constexpr std::uint32_t PresenterGpuHolder = 0xfffffffdu;\n' +
    'struct GpuHolderRecord {\n' +
    '    std::uint32_t tag;\n' +
    '    std::uint8_t site;\n' +
    '    const void* caller;\n' +
    '    std::uint64_t thread;\n' +
    '    std::uint64_t holdSerial;\n' +
    '};\n' +
    'GpuHolderRecord GpuHolder();\n' +
    'const char* GpuLockSiteName(std::uint8_t site);\n'));

  await edit(root, execution + '/src/GuestMemory.cpp', source => {
    source = replace(source, '#include <mutex>\n', '#include <mutex>\n#ifdef __APPLE__\n#include <pthread.h>\n#endif\n');
    source = replace(source,
      'void GpuMutexType::acquired() {\n    owner.store(CurrentThreadToken(), std::memory_order_relaxed);\n    if (++depth == 1) {\n        gpuHoldSerial.fetch_add(1, std::memory_order_relaxed);\n',
      'namespace {\n' +
      '// The outermost holder for GpuHolder: lock() and try_lock() note their caller and the site tagged\n' +
      '// for them; acquired() publishes both when the hold is outermost.\n' +
      'std::atomic<std::uint32_t> gpuHolderTag{NoGpuHolder};\n' +
      'std::atomic<std::uint8_t> gpuHolderSite{0};\n' +
      'std::atomic<const void*> gpuHolderCaller{nullptr};\n' +
      'std::atomic<std::uint64_t> gpuHolderThread{0};\n' +
      'thread_local const void* gpuHolderCallerNext = nullptr;\n' +
      'thread_local std::uint8_t gpuHolderSiteNext = 0;\n' +
      'thread_local std::uint8_t gpuHolderSitePending = 0;\n\n' +
      'std::uint64_t HolderThreadId() {\n' +
      '#ifdef __APPLE__\n' +
      '    std::uint64_t id = 0;\n' +
      '    pthread_threadid_np(nullptr, &id);\n' +
      '    return id;\n' +
      '#else\n' +
      '    return 0;\n' +
      '#endif\n' +
      '}\n' +
      '}\n\n' +
      'void GpuMutexType::acquired() {\n    owner.store(CurrentThreadToken(), std::memory_order_relaxed);\n    if (++depth == 1) {\n        gpuHoldSerial.fetch_add(1, std::memory_order_relaxed);\n' +
      '        gpuHolderCaller.store(gpuHolderCallerNext, std::memory_order_relaxed);\n' +
      '        gpuHolderSite.store(gpuHolderSitePending, std::memory_order_relaxed);\n' +
      '        gpuHolderThread.store(HolderThreadId(), std::memory_order_relaxed);\n' +
      '        gpuHolderTag.store(LockStats().holderColumn == PresenterColumn ? PresenterGpuHolder : GpuLockThreadTag(), std::memory_order_relaxed);\n');
    source = replace(source,
      'bool GpuMutexType::try_lock() {\n',
      'bool GpuMutexType::try_lock() {\n' +
      '    gpuHolderCallerNext = __builtin_return_address(0);\n' +
      '    gpuHolderSitePending = std::exchange(gpuHolderSiteNext, std::uint8_t{0});\n' +
      '    if (gpuHolderSitePending == 0) gpuHolderSitePending = static_cast<std::uint8_t>(GpuLockSite::Try);\n');
    source = replace(source,
      'void GpuMutexType::lock() {\n',
      'void GpuMutexType::lock() {\n' +
      '    gpuHolderCallerNext = __builtin_return_address(0);\n' +
      '    gpuHolderSitePending = std::exchange(gpuHolderSiteNext, std::uint8_t{0});\n');
    source = replace(source,
      '    if (outermost) {\n        owner.store(nullptr, std::memory_order_relaxed);\n',
      '    if (outermost) {\n        owner.store(nullptr, std::memory_order_relaxed);\n        gpuHolderTag.store(NoGpuHolder, std::memory_order_relaxed);\n');
    source = replace(source,
      'void TagGpuLockSite(GpuLockSite site) {\n',
      'void TagGpuLockSite(GpuLockSite site) {\n    gpuHolderSiteNext = static_cast<std::uint8_t>(site);\n');
    return replace(source,
      'std::uint64_t GpuHoldSerial() {\n    return gpuHoldSerial.load(std::memory_order_relaxed);\n}\n',
      'std::uint64_t GpuHoldSerial() {\n    return gpuHoldSerial.load(std::memory_order_relaxed);\n}\n\n' +
      'GpuHolderRecord GpuHolder() {\n' +
      '    return {gpuHolderTag.load(std::memory_order_relaxed), gpuHolderSite.load(std::memory_order_relaxed), gpuHolderCaller.load(std::memory_order_relaxed), gpuHolderThread.load(std::memory_order_relaxed), gpuHoldSerial.load(std::memory_order_relaxed)};\n' +
      '}\n\n' +
      'const char* GpuLockSiteName(std::uint8_t site) {\n' +
      '    return site < GpuLockSiteCount ? GpuLockSiteNames[site] : "unknown";\n' +
      '}\n');
  });

  await edit(root, driverRoot + '/Graphics/include/Recorder.hpp', source => {
    source = replace(source,
      '    static std::uint64_t PendingWriteBackCompletions();\n',
      '    static std::uint64_t PendingWriteBackCompletions();\n' +
      '    // completion labels a CPU write-back moved into the pending count (NoteWrittenBack), in total;\n' +
      '    static std::uint64_t CompletionLabelsCountedLate();\n' +
      '    // batches alive on every recorder (open, in flight or finishing), lock-free;\n' +
      '    static std::uint64_t LiveBatches();\n' +
      '    // called when a completion becomes pending outside a queue packet\'s own accounting (a late count\n' +
      '    // in NoteWrittenBack) or a deferred action is appended (AfterRecordedWork), possibly under\n' +
      '    // GpuMutex, so it must take neither GpuMutex nor a lock held around GpuMutex; nullptr clears it;\n' +
      '    static void SetCompletionWake(void (*wake)());\n');
    return replace(source,
      '    struct Batch {\n        VkCommandBuffer commands = VK_NULL_HANDLE;\n',
      '    // Counts every Batch alive for LiveBatches.\n' +
      '    struct LiveBatch {\n' +
      '        LiveBatch();\n' +
      '        LiveBatch(const LiveBatch&);\n' +
      '        LiveBatch& operator=(const LiveBatch&) { return *this; }\n' +
      '        ~LiveBatch();\n' +
      '    };\n' +
      '    struct Batch {\n        LiveBatch live;\n        VkCommandBuffer commands = VK_NULL_HANDLE;\n');
  });

  await edit(root, driverRoot + '/Graphics/src/Recorder.cpp', source => {
    source = replace(source,
      'std::atomic<std::uint64_t> completionLabelsCountedLate{0};\n',
      'std::atomic<std::uint64_t> completionLabelsCountedLate{0};\n' +
      'std::atomic<std::uint64_t> liveBatches{0};\n' +
      'std::atomic<void (*)()> completionWake{nullptr};\n' +
      'void WakeForCompletions() {\n' +
      '    if (auto* wake = completionWake.load(std::memory_order_acquire); wake != nullptr) wake();\n' +
      '}\n');
    source = replace(source,
      'std::uint64_t Recorder::PendingWriteBackCompletions() {\n    return writeBackCompletions.load(std::memory_order_acquire);\n}\n',
      'std::uint64_t Recorder::PendingWriteBackCompletions() {\n    return writeBackCompletions.load(std::memory_order_acquire);\n}\n\n' +
      'std::uint64_t Recorder::CompletionLabelsCountedLate() {\n    return completionLabelsCountedLate.load(std::memory_order_relaxed);\n}\n\n' +
      'Recorder::LiveBatch::LiveBatch() {\n    liveBatches.fetch_add(1, std::memory_order_relaxed);\n}\n\n' +
      'Recorder::LiveBatch::LiveBatch(const LiveBatch&) {\n    liveBatches.fetch_add(1, std::memory_order_relaxed);\n}\n\n' +
      'Recorder::LiveBatch::~LiveBatch() {\n    liveBatches.fetch_sub(1, std::memory_order_relaxed);\n}\n\n' +
      'std::uint64_t Recorder::LiveBatches() {\n    return liveBatches.load(std::memory_order_relaxed);\n}\n\n' +
      'void Recorder::SetCompletionWake(void (*wake)()) {\n    completionWake.store(wake, std::memory_order_release);\n}\n');
    source = replace(source,
      '    return true;\n}\n\nvoid Recorder::NoteWrittenBack(std::uint64_t address, std::size_t bytes) {\n',
      '    WakeForCompletions();\n    return true;\n}\n\nvoid Recorder::NoteWrittenBack(std::uint64_t address, std::size_t bytes) {\n');
    return replace(source,
      '    if (recorder->open != nullptr) count(*recorder->open);\n    for (auto& batch : recorder->inFlight) count(*batch);\n}\n',
      '    const auto lateBefore = completionLabelsCountedLate.load(std::memory_order_relaxed);\n' +
      '    if (recorder->open != nullptr) count(*recorder->open);\n    for (auto& batch : recorder->inFlight) count(*batch);\n' +
      '    if (completionLabelsCountedLate.load(std::memory_order_relaxed) != lateBefore) WakeForCompletions();\n}\n');
  });

  await edit(root, execution + '/include/Driver/Driver.hpp', source => {
    source = replace(source,
      '#include "prx/libSceAgcDriver/Execution/include/Driver/Queues/Submission.hpp"\n',
      '#include "prx/libSceAgcDriver/Execution/include/Driver/Queues/Submission.hpp"\n#include <stop_token>\n#include <thread>\n');
    source = replace(source,
      '    void reapCompletionLabels();\n    void run(std::uint32_t id) noexcept;\n',
      '    void reapCompletionLabels();\n    void run(std::uint32_t id) noexcept;\n' +
      '    // Queue 0\'s wait state for the stall watchdog (queue0WaitState) and the watchdog itself.\n' +
      '    enum : std::uint32_t { QueueWaitActive = 0, QueueWaitUntimed, QueueWaitBounded, QueueWaitPoll };\n' +
      '    static bool boundedIdleWait();\n' +
      '    void startQueueWatchdog();\n' +
      '    void stopQueueWatchdog();\n' +
      '    void watchQueueZero(std::stop_token stop);\n');
    return replace(source,
      '    std::atomic<std::uint64_t> packetsDone{0};\n',
      '    std::atomic<std::uint64_t> packetsDone{0};\n' +
      '    std::atomic<std::uint32_t> queue0WaitState{QueueWaitActive};\n' +
      '    std::atomic<std::uint64_t> queue0Submissions{0};\n' +
      '    std::atomic<std::uint64_t> idleTryFailStreak{0};\n' +
      '    std::atomic<std::uint64_t> deferredInterrupts{0};\n' +
      '    std::atomic<std::uint64_t> deferredInterruptsRun{0};\n' +
      '    std::jthread queueWatchdog;\n');
  });

  await edit(root, execution + '/src/Driver/Queues/QueueWorker.cpp', source => {
    source = replace(source,
      '    if (!gpuLock.owns_lock()) {\n        ++triesFailed[TryIdle];\n        return;\n    }\n\n    if (!completionsPending()) return;\n',
      '    if (!gpuLock.owns_lock()) {\n        ++triesFailed[TryIdle];\n        idleTryFailStreak.fetch_add(1, std::memory_order_relaxed);\n        return;\n    }\n' +
      '    idleTryFailStreak.store(0, std::memory_order_relaxed);\n\n    if (!completionsPending()) return;\n');
    source = replace(source,
      '                        changed.wait(lock, [&] { return ready() || (id == 0 && (idleEpoch.load(std::memory_order_acquire) != idleEpochAtWait || completionsPending())); });\n',
      '                        const bool bounded = QueueZeroIdleBounded(id, boundedIdleWait(), device.Load() != nullptr, Graphics::Recorder::LiveBatches());\n' +
      '                        if (id == 0) queue0WaitState.store(bounded ? QueueWaitBounded : QueueWaitUntimed, std::memory_order_relaxed);\n' +
      '                        QueueIdleWait(changed, lock, bounded, [&] { return ready() || (id == 0 && (idleEpoch.load(std::memory_order_acquire) != idleEpochAtWait || completionsPending())); });\n' +
      '                        if (id == 0) queue0WaitState.store(QueueWaitActive, std::memory_order_relaxed);\n');
    source = replace(source,
      '                    if (poll(ready)) break;\n                    lock.unlock();\n                    reapCompletionLabels();\n',
      '                    if (id == 0) queue0WaitState.store(QueueWaitPoll, std::memory_order_relaxed);\n' +
      '                    if (poll(ready)) break;\n                    lock.unlock();\n                    reapCompletionLabels();\n');
    source = replace(source,
      '                if (id == 0) queue0Executing = submission.suspend ? 0 : submission.received;\n',
      '                if (id == 0) queue0Executing = submission.suspend ? 0 : submission.received;\n' +
      '                if (id == 0) {\n                    queue0WaitState.store(QueueWaitActive, std::memory_order_relaxed);\n                    queue0Submissions.fetch_add(1, std::memory_order_relaxed);\n                }\n');
    if (!source.endsWith('\n}\n')) throw Error('AnyPS5 completion wake source changed: QueueWorker.cpp ending');
    source = replace(source, '#include <algorithm>\n',
      '#include "prx/libSceAgcDriver/Execution/include/Driver/Queues/QueueStallWatch.hpp"\n#include <algorithm>\n#include <cstdio>\n#include <iterator>\n#include <string>\n#ifndef _WIN32\n#include <dlfcn.h>\n#endif\n');
    return source + watchdogSource;
  });

  await edit(root, execution + '/src/Driver/Queues/Submission.cpp', source => replace(source,
    '    if (!worker.thread.joinable()) worker.thread = std::thread([this, queue] {\n',
    '    if (queue == 0 && !queueWatchdog.joinable()) startQueueWatchdog();\n    if (!worker.thread.joinable()) worker.thread = std::thread([this, queue] {\n'));

  await edit(root, execution + '/src/Driver/Lifecycle.cpp', source => replace(source,
    '    changed.notify_all();\n    for (auto& [queue, worker] : workers) {\n        if (worker.thread.joinable()) worker.thread.join();\n    }\n',
    '    changed.notify_all();\n    stopQueueWatchdog();\n    for (auto& [queue, worker] : workers) {\n        if (worker.thread.joinable()) worker.thread.join();\n    }\n'));

  await edit(root, execution + '/src/Driver/Packets/PacketMemory.cpp', source => {
    source = replace(source,
      '                interruptDeferred = localDevice->AfterRecordedWork([this, queueId, context] { deliverGuestEopInterrupt(queueId, context); }, submission.queue == 0);\n',
      '                interruptDeferred = localDevice->AfterRecordedWork([this, queueId, context] {\n' +
      '                    deferredInterruptsRun.fetch_add(1, std::memory_order_relaxed);\n' +
      '                    deliverGuestEopInterrupt(queueId, context);\n' +
      '                }, submission.queue == 0);\n' +
      '                if (interruptDeferred) deferredInterrupts.fetch_add(1, std::memory_order_relaxed);\n');
    return replace(source,
      '            deferred = localDevice->AfterRecordedWork([this, queue, context] { deliverGuestEopInterrupt(queue, context); }, queue == 0);\n',
      '            deferred = localDevice->AfterRecordedWork([this, queue, context] {\n' +
      '                deferredInterruptsRun.fetch_add(1, std::memory_order_relaxed);\n' +
      '                deliverGuestEopInterrupt(queue, context);\n' +
      '            }, queue == 0);\n' +
      '            if (deferred) deferredInterrupts.fetch_add(1, std::memory_order_relaxed);\n');
  });
}
