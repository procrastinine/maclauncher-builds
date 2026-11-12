import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyCompletionWakeOverlay} from '../producers/anyps5/overlays/completion-wake/apply.mjs';
import {applyPresentRetireCountOverlay} from '../producers/anyps5/overlays/present-retire-count/apply.mjs';

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
 deviceHeader:execution+'/include/VulkanDevice.hpp',
 device:execution+'/src/VulkanDevice.cpp',
 presentation:execution+'/src/Driver/Presentation.cpp',
};
const skip=Object.values(files).every(file=>fs.existsSync(path.join(upstream,file)))?false:'Source tree sources/anyps5 is not initialized.';

function body(source,signature){
 const start=source.indexOf(signature),end=source.indexOf('\n}\n',start);
 assert.ok(start>=0&&end>start,signature);
 return source.slice(start,end)+'\n}\n';
}

test('batches whose stamps were not ready at their finish are timed at the present retire and counted',{skip},async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'anyps5-present-retire-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const file of Object.values(files)){
  fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
  fs.copyFileSync(path.join(upstream,file),path.join(root,file));
 }
 fs.mkdirSync(path.join(root,execution,'include/Driver/Queues'),{recursive:true});
 // The projection order: the completion wake overlay edits Recorder.cpp first.
 await applyCompletionWakeOverlay(root);
 await applyPresentRetireCountOverlay(root);
 const recorder=fs.readFileSync(path.join(root,files.recorder),'utf8');
 assert.match(body(recorder,'void Recorder::readGpuTiming(Batch& batch) {'),/if \(result == VK_NOT_READY && !GpuTimingEnabled\(\) && batch\.batchTiming == 0\) batch\.stampsLate = true;/);
 const finish=body(recorder,'void Recorder::finish(std::unique_ptr<Batch> batch, bool wait, int source, bool releaseNow) {');
 assert.ok(finish.indexOf('readGpuTiming(*batch);')<finish.indexOf('entry.lateStamps = batch->stampsLate ? std::exchange(batch->queries, VK_NULL_HANDLE) : VK_NULL_HANDLE;'));
 const completed=body(recorder,'std::vector<Recorder::Completed> Recorder::CompletedBatches(');
 assert.ok(completed.indexOf('std::lock_guard lock(completedMutex);')<completed.indexOf('resolveLateStamps(entry);'),'late stamps are read under the ring mutex');
 assert.match(body(recorder,'void Recorder::resolveLateStamps(Completed& entry) {'),/if \(result == VK_NOT_READY\) return;[\s\S]*vkDestroyQueryPool/);
 const device=fs.readFileSync(path.join(root,files.device),'utf8');
 assert.match(device,/const auto lateBefore = Graphics::Recorder::LateStampsRead\(\);\n            const auto batches = recorder->CompletedBatches\(range\.afterSerial, range\.throughSerial, missing\);\n            presentCounters\.lateStamped \+= /);
 const presentation=fs.readFileSync(path.join(root,files.presentation),'utf8');
 assert.match(presentation,/batches without a completion record, %llu timed at the retire\)/);
 assert.match(presentation,/counts\.gpuUnread - previous\.gpuUnread\), static_cast<unsigned long long>\(counts\.lateStamped - previous\.lateStamped\), /);
});
