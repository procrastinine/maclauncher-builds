import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applyCompletionWakeOverlay} from '../producers/anyps5/overlays/completion-wake/apply.mjs';

const upstream=process.env.ANYPS5_TEST_SOURCE||fileURLToPath(new URL('../sources/anyps5/',import.meta.url));
const driver='core/libs/prx/libSceAgcDriver';
const execution=driver+'/Execution';
const files={
 memoryHeader:execution+'/include/GuestMemory.hpp',
 memory:execution+'/src/GuestMemory.cpp',
 recorderHeader:driver+'/Graphics/include/Recorder.hpp',
 recorder:driver+'/Graphics/src/Recorder.cpp',
 driverHeader:execution+'/include/Driver/Driver.hpp',
 worker:execution+'/src/Driver/Queues/QueueWorker.cpp',
 submission:execution+'/src/Driver/Queues/Submission.cpp',
 lifecycle:execution+'/src/Driver/Lifecycle.cpp',
 packets:execution+'/src/Driver/Packets/PacketMemory.cpp',
};
const header=fileURLToPath(new URL('../producers/anyps5/overlays/completion-wake/QueueStallWatch.hpp',import.meta.url));
const skip=Object.values(files).every(file=>fs.existsSync(path.join(upstream,file)))?false:'Source tree sources/anyps5 is not initialized.';
const compilerSkip=process.platform==='win32'?'Fixture uses a POSIX compiler.':false;

function projection(t,adapt=source=>source){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'anyps5-completion-wake-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const file of Object.values(files)){
  const target=path.join(root,file);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,adapt(fs.readFileSync(path.join(upstream,file),'utf8'),file));
 }
 fs.mkdirSync(path.join(root,execution,'include/Driver/Queues'),{recursive:true});
 return root;
}
function body(source,signature){
 const start=source.indexOf(signature),end=source.indexOf('\n}\n',start);
 assert.ok(start>=0&&end>start,signature);
 return source.slice(start,end)+'\n}\n';
}
const read=(root,file)=>fs.readFileSync(path.join(root,file),'utf8');

test('queue 0 is woken for completions counted off the worker and waits at most 2 ms while batches exist',{skip},async t=>{
 const root=projection(t);
 await applyCompletionWakeOverlay(root);
 assert.ok(fs.existsSync(path.join(root,execution,'include/Driver/Queues/QueueStallWatch.hpp')));
 const recorder=read(root,files.recorder);
 const noteWrittenBack=body(recorder,'void Recorder::NoteWrittenBack(std::uint64_t address, std::size_t bytes) {');
 assert.ok(noteWrittenBack.indexOf('const auto lateBefore = completionLabelsCountedLate.load')<noteWrittenBack.indexOf('if (recorder->open != nullptr) count(*recorder->open);'));
 assert.match(noteWrittenBack,/for \(auto& batch : recorder->inFlight\) count\(\*batch\);\n    if \(completionLabelsCountedLate\.load\(std::memory_order_relaxed\) != lateBefore\) WakeForCompletions\(\);\n\}/);
 assert.match(recorder,/    WakeForCompletions\(\);\n    return true;\n\}\n\nvoid Recorder::NoteWrittenBack/,'an appended deferred action wakes queue 0');
 assert.match(recorder,/Recorder::LiveBatch::~LiveBatch\(\) \{\n    liveBatches\.fetch_sub/);
 assert.match(read(root,files.recorderHeader),/    struct Batch \{\n        LiveBatch live;\n/);
 const worker=read(root,files.worker);
 const run=body(worker,'void Driver::run(std::uint32_t id) noexcept {');
 assert.doesNotMatch(run,/changed\.wait\(lock, \[&\] \{ return ready\(\) \|\| \(id == 0/,'the untimed idle wait is replaced');
 const bounded=run.indexOf('const bool bounded = QueueZeroIdleBounded(id, boundedIdleWait(), device.Load() != nullptr, Graphics::Recorder::LiveBatches());');
 const wait=run.indexOf('QueueIdleWait(changed, lock, bounded, [&] { return ready() || (id == 0 && (idleEpoch.load(std::memory_order_acquire) != idleEpochAtWait || completionsPending())); });');
 assert.ok(bounded>0&&bounded<wait);
 assert.ok(run.indexOf('queue0Submissions.fetch_add(1, std::memory_order_relaxed);')>run.indexOf('if (id == 0) queue0Executing = submission.suspend ? 0 : submission.received;'));
 const reap=body(worker,'void Driver::reapCompletionLabels() {');
 assert.match(reap,/\+\+triesFailed\[TryIdle\];\n        idleTryFailStreak\.fetch_add\(1, std::memory_order_relaxed\);\n        return;/);
 assert.match(reap,/idleTryFailStreak\.store\(0, std::memory_order_relaxed\);/);
 const start=body(worker,'void Driver::startQueueWatchdog() {');
 assert.match(start,/Graphics::Recorder::SetCompletionWake\(\[\] \{ Get\(\)\.changed\.notify_all\(\); \}\);/);
 assert.doesNotMatch(start,/lock_guard|unique_lock/,'the wake takes no driver mutex');
 assert.match(read(root,files.submission),/if \(queue == 0 && !queueWatchdog\.joinable\(\)\) startQueueWatchdog\(\);/);
 assert.match(read(root,files.lifecycle),/changed\.notify_all\(\);\n    stopQueueWatchdog\(\);\n    for \(auto& \[queue, worker\] : workers\)/);
 const packets=read(root,files.packets);
 assert.equal((packets.match(/deferredInterruptsRun\.fetch_add\(1, std::memory_order_relaxed\);/g)||[]).length,2);
 assert.equal((packets.match(/deferredInterrupts\.fetch_add\(1, std::memory_order_relaxed\);/g)||[]).length,2);
});

test('the GPU mutex records its outermost holder, lock site and caller at acquisition',{skip},async t=>{
 const root=projection(t);
 await applyCompletionWakeOverlay(root);
 const memory=read(root,files.memory);
 const acquired=body(memory,'void GpuMutexType::acquired() {');
 assert.match(acquired,/if \(\+\+depth == 1\) \{[\s\S]*gpuHolderCaller\.store\(gpuHolderCallerNext[\s\S]*gpuHolderSite\.store\(gpuHolderSitePending[\s\S]*gpuHolderThread\.store\(HolderThreadId\(\)[\s\S]*gpuHolderTag\.store\(LockStats\(\)\.holderColumn == PresenterColumn \? PresenterGpuHolder : GpuLockThreadTag\(\)/);
 for(const signature of ['void GpuMutexType::lock() {','bool GpuMutexType::try_lock() {']){
  const lock=body(memory,signature);
  assert.ok(lock.indexOf('gpuHolderCallerNext = __builtin_return_address(0);')<lock.indexOf('if (!GpuLockProfiled())'),signature);
  assert.ok(lock.indexOf('gpuHolderSitePending = std::exchange(gpuHolderSiteNext, std::uint8_t{0});')<lock.indexOf('if (!GpuLockProfiled())'),signature);
 }
 assert.match(body(memory,'bool GpuMutexType::try_lock() {'),/if \(gpuHolderSitePending == 0\) gpuHolderSitePending = static_cast<std::uint8_t>\(GpuLockSite::Try\);/);
 const tag=body(memory,'void TagGpuLockSite(GpuLockSite site) {');
 assert.ok(tag.indexOf('gpuHolderSiteNext = static_cast<std::uint8_t>(site);')<tag.indexOf('if (!GpuLockProfiled() && !PerformanceTrace::Recording()) return;'),'the site is noted on the unprofiled path too');
 assert.match(body(memory,'void GpuMutexType::unlock() {'),/if \(outermost\) \{\n        owner\.store\(nullptr, std::memory_order_relaxed\);\n        gpuHolderTag\.store\(NoGpuHolder/);
 const memoryHeader=read(root,files.memoryHeader);
 assert.match(memoryHeader,/constexpr std::uint32_t NoGpuHolder = 0xfffffffcu;/);
 assert.match(memoryHeader,/GpuHolderRecord GpuHolder\(\);/);
});

test('the watchdog reports the worker wait, the GPU mutex holder, pending completions and the last packets once per stall',{skip},async t=>{
 const root=projection(t);
 await applyCompletionWakeOverlay(root);
 const watch=body(read(root,files.worker),'void Driver::watchQueueZero(std::stop_token stop) {');
 assert.match(watch,/APS5_QUEUE_WATCHDOG_MS/);
 assert.match(watch,/if \(!watch\.Observe\(queue0Submissions\.load\(std::memory_order_relaxed\), packet, pending, now\)\) \{/);
 for(const field of ['idle GpuMutex try-locks failed in a row','GpuMutex held by %s (thread id %llu), taken at site','completion labels and actions','deferred end-of-pipe interrupts','labels counted late at CPU write-backs','batches alive','last packets:%s'])
  assert.ok(watch.includes(field),field);
 assert.match(watch,/completionsPending\(\) \|\| interrupts != 0 \|\| labelSince\.has_value\(\) \|\| recorded != 0 \|\| batches != 0 \|\| state == QueueWaitActive/);
});

test('unrecognized completion and lock anchors are refused',{skip},async t=>{
 for(const [file,anchor,changed] of [
  [files.worker,'++triesFailed[TryIdle];\n        return;','++triesFailed[TryIdle]; return;'],
  [files.recorder,'    for (auto& batch : recorder->inFlight) count(*batch);\n}\n','    for (auto& batch : recorder->inFlight) { count(*batch); }\n}\n'],
  [files.memory,'void TagGpuLockSite(GpuLockSite site) {\n','void TagGpuLockSite(GpuLockSite site)\n{\n'],
 ]){
  const root=projection(t,(source,current)=>current===file?source.replace(anchor,changed):source);
  await assert.rejects(applyCompletionWakeOverlay(root),/completion wake source changed/);
 }
});

const fixture=`#include "QueueStallWatch.hpp"
#include <atomic>
#include <cstdio>
#include <mutex>
#include <thread>
using namespace AgcDriver::DriverDetail;
using Clock = QueueStallWatch::Clock;
static int fail(const char* what) { std::fprintf(stderr, "%s\\n", what); return 1; }
int main() {
    const auto t0 = Clock::now();
    const auto at = [&](int ms) { return t0 + std::chrono::milliseconds(ms); };
    {
        QueueStallWatch watch(std::chrono::milliseconds(5000), 10, 0x2a01, at(0));
        if (watch.Observe(10, 0x2a01, true, at(4900))) return fail("reported before the threshold");
        if (!watch.Observe(10, 0x2a01, true, at(5000))) return fail("no report at the threshold");
        for (int ms = 5100; ms < 60000; ms += 100) {
            if (watch.Observe(10, 0x2a01, true, at(ms))) return fail("reported twice for one stall");
        }
        if (watch.StalledSeconds(at(60000)) < 59.9) return fail("stall length");
        if (watch.Observe(11, 0x2a01, true, at(60100)) || !watch.Moved()) return fail("a dequeue is not movement");
        if (watch.Observe(11, 0x2a01, true, at(65000))) return fail("re-armed report too early");
        if (!watch.Observe(11, 0x2a01, true, at(65100))) return fail("not re-armed after queue 0 moved");
        if (watch.Observe(11, 0x3c05, true, at(65200)) || !watch.Moved()) return fail("a new packet is not movement");
    }
    {
        QueueStallWatch watch(std::chrono::milliseconds(5000), 3, 0, at(0));
        if (watch.Observe(3, 0, false, at(9000))) return fail("reported with nothing pending");
        if (!watch.Observe(3, 0, true, at(9100))) return fail("pending work after the threshold does not report");
        QueueStallWatch off(std::chrono::milliseconds(0), 3, 0, at(0));
        if (off.Observe(3, 0, true, at(100000))) return fail("a zero threshold reported");
    }
    if (!QueueZeroIdleBounded(0, true, true, 1) || QueueZeroIdleBounded(1, true, true, 1) || QueueZeroIdleBounded(0, false, true, 1) || QueueZeroIdleBounded(0, true, false, 1) || QueueZeroIdleBounded(0, true, true, 0))
        return fail("bounded wait selection");
    {
        // A completion made pending without a notify the waiter can see (the race the bound covers):
        // the bounded wait returns within a few milliseconds; a fallback notify after 2 s keeps an
        // untimed wait from hanging the fixture.
        std::mutex mutex;
        std::condition_variable changed;
        std::atomic<bool> pending{false};
        std::atomic<bool> done{false};
        std::thread fallback([&] {
            for (int i = 0; i < 200 && !done.load(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
            changed.notify_all();
        });
        std::unique_lock lock(mutex);
        pending.store(true);
        const auto start = Clock::now();
        QueueIdleWait(changed, lock, true, [&] { return pending.load(); });
        if (Clock::now() - start > std::chrono::milliseconds(100)) return fail("a predicate already true waited");
        const auto timed = Clock::now();
        QueueIdleWait(changed, lock, true, [&] { return false; });
        const auto bounded = Clock::now() - timed;
        done.store(true);
        lock.unlock();
        fallback.join();
        if (bounded > std::chrono::milliseconds(500)) return fail("the bounded wait did not return on its own");
        if (bounded < std::chrono::milliseconds(1)) return fail("the bounded wait did not wait");
    }
    std::puts("ok");
    return 0;
}
`;

test('the stall report fires once per stall and the bounded idle wait returns without a notify',{skip:compilerSkip},t=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'anyps5-stall-watch-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.copyFileSync(header,path.join(directory,'QueueStallWatch.hpp'));
 fs.writeFileSync(path.join(directory,'watch.cpp'),fixture);
 const compiler=process.env.CXX||(fs.existsSync('/usr/bin/clang++')?'/usr/bin/clang++':'c++');
 const built=spawnSync(compiler,['-std=c++20','-O1','-pthread','-Wall','-Werror','-o',path.join(directory,'watch'),path.join(directory,'watch.cpp')],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(path.join(directory,'watch'),{encoding:'utf8',timeout:60000});
 assert.equal(ran.status,0,ran.stderr);
 assert.equal(ran.stdout.trim(),'ok');
});
