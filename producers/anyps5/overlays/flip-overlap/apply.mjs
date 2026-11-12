// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 flip submission source changed: ' + before.slice(0, 100));
  return source.replace(before, after);
}

const ended = 'failure != nullptr || stopping.load(std::memory_order_acquire) || shutdownToken.stop_requested()';

// A command-buffer flip submission is accepted while the previous flip submission's GPU work runs.
// The submitter holding the one overlap token waits for and reaps that work, on the device whose
// recorder issued its serial, before Submit returns.
export async function applyFlipOverlapOverlay(root) {
  const base = path.join(root, 'core/libs/prx/libSceAgcDriver/Execution');
  const edit = async (relative, transform) => {
    const file = path.join(base, relative);
    await fs.writeFile(file, transform(await fs.readFile(file, 'utf8')));
  };
  await fs.copyFile(path.join(import.meta.dirname, 'FlipOverlap.hpp'), path.join(base, 'include/Driver/Queues/FlipOverlap.hpp'));

  await edit('include/Driver/Driver.hpp', source => {
    source = replace(source, '#include "prx/libSceAgcDriver/Execution/include/Driver/Queues/SubmissionRing.hpp"\n',
      '#include "prx/libSceAgcDriver/Execution/include/Driver/Queues/SubmissionRing.hpp"\n#include "prx/libSceAgcDriver/Execution/include/Driver/Queues/FlipOverlap.hpp"\n');
    source = replace(source, '    void holdFlipBehindWorker(const Submission& submission, bool cpuFlip);\n',
      `    void holdFlipBehindWorker(const Submission& submission, bool cpuFlip, FlipOverlapClaim<VulkanDevice>& overlap);
    void finishFlipOverlap(FlipOverlapClaim<VulkanDevice>& overlap);
    void waitFlipWorkOn(std::shared_ptr<VulkanDevice>& localDevice, std::uint64_t workSerial);
    FlipWork<VulkanDevice> submitFlipWorkBound(std::uint32_t queue, std::uint64_t submissionSerial);
    void finishFlipWorkBound(FlipWork<VulkanDevice> work);
`);
    return replace(source, '    std::atomic<bool> queue0AwaitsTitle{false};\n',
      `    std::atomic<bool> queue0AwaitsTitle{false};
    // Guarded by mutex: the overlap token and the device whose recorder issued flipWorkSerial.
    FlipOverlapGate flipOverlapGate;
    std::shared_ptr<VulkanDevice> flipWorkDevice;
    std::uint64_t flipWorkSubmission = 0;
`);
  });

  await edit('src/Driver/Queues/Submission.cpp', source => {
    source = replace(source, 'void Driver::holdFlipBehindWorker(const Submission& submission, bool cpuFlip) {\n',
      'void Driver::holdFlipBehindWorker(const Submission& submission, bool cpuFlip, FlipOverlapClaim<VulkanDevice>& overlap) {\n');
    source = replace(source, '    if (!flips) return;\n    flipHolders.fetch_add(1, std::memory_order_acq_rel);\n',
      `    if (!flips) return;
    if (!cpuFlip && FlipOverlapEnabled()) {
        // Admission bounds the overlap to one submission across every submitting thread. A title-only
        // label wait releases a waiter without the token, which then keeps the waits below.
        flipHolders.fetch_add(1, std::memory_order_acq_rel);
        overlap.owner = flipOverlapGate.Admit(lock, changed, [&] { return ${ended} || queue0AwaitsTitle.load(std::memory_order_acquire); });
        flipHolders.fetch_sub(1, std::memory_order_acq_rel);
        if (${ended}) return;
    }
    flipHolders.fetch_add(1, std::memory_order_acq_rel);
`);
    source = replace(source, '    const auto workSerial = flipWorkSerial.load(std::memory_order_acquire);\n    lock.unlock();\n    waitFlipWork(workSerial);\n}\n',
      `    const auto workSerial = flipWorkSerial.load(std::memory_order_acquire);
    if (overlap.owner && workSerial != 0 && flipWorkDevice != nullptr && flipWorkDevice->CanWaitUnlocked()) {
        // Submit enqueues first and then waits for and reaps this work (finishFlipOverlap).
        overlap.work = FlipWork<VulkanDevice>{flipWorkDevice, workSerial};
        overlap.deferred = true;
        return;
    }
    auto localDevice = flipWorkDevice;
    lock.unlock();
    if (localDevice == nullptr) { waitFlipWork(workSerial); return; }
    try {
        if (localDevice->CanWaitUnlocked()) { waitFlipWorkOn(localDevice, workSerial); return; }
        GuestMemory::TagGpuLockSite(GuestMemory::GpuLockSite::Wait);
        std::lock_guard gpuLock(GuestMemory::GpuMutex());
        localDevice->WaitIdle();
        localDevice.reset();
    } catch (...) {
        GuestMemory::TagGpuLockSite(GuestMemory::GpuLockSite::Wait);
        std::lock_guard gpuLock(GuestMemory::GpuMutex());
        localDevice.reset();
        throw;
    }
}
`);
    source = replace(source, 'void Driver::releaseFlipHold() {\n', `void Driver::waitFlipWorkOn(std::shared_ptr<VulkanDevice>& localDevice, std::uint64_t workSerial) {
    localDevice->WaitRecorded(workSerial);
    GuestMemory::TagGpuLockSite(GuestMemory::GpuLockSite::Wait);
    std::lock_guard gpuLock(GuestMemory::GpuMutex());
    localDevice->ReapRecorded(workSerial);
    localDevice.reset();
}

void Driver::finishFlipOverlap(FlipOverlapClaim<VulkanDevice>& overlap) {
    overlap.Finish([this](FlipWork<VulkanDevice>& work) { waitFlipWorkOn(work.device, work.serial); }, [this](std::shared_ptr<VulkanDevice>& localDevice) {
        if (localDevice != nullptr) {
            GuestMemory::TagGpuLockSite(GuestMemory::GpuLockSite::Wait);
            std::lock_guard gpuLock(GuestMemory::GpuMutex());
            localDevice.reset();
        }
        {
            std::lock_guard lock(mutex);
            flipOverlapGate.Leave();
        }
        changed.notify_all();
    });
}

void Driver::finishFlipWorkBound(FlipWork<VulkanDevice> work) {
    std::shared_ptr<VulkanDevice> replaced;
    {
        std::lock_guard lock(mutex);
        // Order publications by driver submission first; recorder serials are device-local.
        if (work.serial != 0 && (work.submission > flipWorkSubmission || (work.submission == flipWorkSubmission && work.device == flipWorkDevice && work.serial > flipWorkSerial.load(std::memory_order_relaxed)))) {
            flipWorkSubmission = work.submission;
            flipWorkSerial.store(work.serial, std::memory_order_release);
            replaced = std::exchange(flipWorkDevice, std::move(work.device));
        }
        flipWorkOpen.fetch_sub(1, std::memory_order_acq_rel);
        if (flipHolders.load(std::memory_order_acquire) != 0) changed.notify_all();
    }
    if (replaced == nullptr && work.device == nullptr) return;
    GuestMemory::TagGpuLockSite(GuestMemory::GpuLockSite::End);
    std::lock_guard gpuLock(GuestMemory::GpuMutex());
    replaced.reset();
    work.device.reset();
}

void Driver::releaseFlipHold() {
`);
    source = replace(source, '    waitForFlipRoom(submission);\n    holdFlipBehindWorker(submission, cpuFlip);\n',
      `    waitForFlipRoom(submission);
    struct FlipOverlapExit {
        Driver& driver;
        FlipOverlapClaim<VulkanDevice> claim;
        ~FlipOverlapExit() {
            if (!claim.owner) return;
            try {
                driver.finishFlipOverlap(claim);
            } catch (...) {
            }
        }
    } flipOverlap{*this, {}};
    holdFlipBehindWorker(submission, cpuFlip, flipOverlap.claim);
`);
    return replace(source, '    changed.notify_all();\n    if (capture != nullptr) writeCaptured(*this, *capture, captured);\n    if (progress) {\n',
      '    changed.notify_all();\n    finishFlipOverlap(flipOverlap.claim);\n    if (capture != nullptr) writeCaptured(*this, *capture, captured);\n    if (progress) {\n');
  });

  await edit('src/Driver/Queues/QueueWorker.cpp', source => {
    source = replace(source, 'std::uint64_t Driver::submitFlipWork(std::uint32_t queue) {\n', `FlipWork<VulkanDevice> Driver::submitFlipWorkBound(std::uint32_t queue, std::uint64_t submissionSerial) {
    GuestMemory::TagGpuLockSite(GuestMemory::GpuLockSite::End);
    std::lock_guard gpuLock(GuestMemory::GpuMutex());
    auto localDevice = device.Load();
    recordDeferredLabels(localDevice.get(), queue);
    const auto serial = localDevice != nullptr ? localDevice->SubmitAndEpoch() : 0;
    if (serial == 0) localDevice.reset();
    return FlipWork<VulkanDevice>{std::move(localDevice), serial, submissionSerial};
}

std::uint64_t Driver::submitFlipWork(std::uint32_t queue) {
`);
    return replace(source, '    if (holdsFlip) finishFlipWork(submitFlipWork(0));\n    else submitOpenWork(progress);\n}\n',
      '    if (holdsFlip) finishFlipWorkBound(submitFlipWorkBound(0, serial));\n    else submitOpenWork(progress);\n}\n');
  });

  await edit('src/Driver/Packets/PacketExecution.cpp', source => {
    source = replace(source, '        std::uint32_t queue;\n        bool held;', '        std::uint32_t queue;\n        std::uint64_t serial;\n        bool held;');
    source = replace(source, '} flipHold{*this, submission.queue, submission.holdsFlip, submission.holdsFlip};', '} flipHold{*this, submission.queue, submission.serial, submission.holdsFlip, submission.holdsFlip};');
    source = replace(source, 'DrawPipeline::Queue0().Enqueue(DrawPipeline::CommitKind::SubmitEnd, [this, holdsFlip, progress = submission.progress] {', 'DrawPipeline::Queue0().Enqueue(DrawPipeline::CommitKind::SubmitEnd, [this, holdsFlip, progress = submission.progress, serial = submission.serial] {');
    source = replace(source, '            const auto workSerial = driver.submitFlipWork(queue);\n            working = false;\n            driver.finishFlipWork(workSerial);\n',
      '            auto work = driver.submitFlipWorkBound(queue, serial);\n            working = false;\n            driver.finishFlipWorkBound(std::move(work));\n');
    return replace(source, '                if (holdsFlip) finishFlipWork(submitFlipWork(0));\n',
      '                if (holdsFlip) finishFlipWorkBound(submitFlipWorkBound(0, serial));\n');
  });

  await edit('src/Driver/Lifecycle.cpp', source => replace(source,
    '    std::lock_guard gpuLock(GuestMemory::GpuMutex());\n    Graphics::ReportHostImports();\n    device.Reset();\n    replacedDevices.clear();\n',
    `    std::shared_ptr<VulkanDevice> flipDevice;
    {
        std::lock_guard lock(mutex);
        flipDevice = std::move(flipWorkDevice);
    }
    std::lock_guard gpuLock(GuestMemory::GpuMutex());
    Graphics::ReportHostImports();
    flipDevice.reset();
    device.Reset();
    replacedDevices.clear();
`));
}
