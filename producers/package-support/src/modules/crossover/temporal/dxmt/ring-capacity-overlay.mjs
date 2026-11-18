// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from 时雨's DXMT command-slot reservation fix, origin
// a350b20e51d8dd23d8244451f482151b146877a1, as carried by fxgl/steamac
// 32a66354a24cc62d4c9ec1d263c5df7a0b1e1d7e, host/dxmt/patches/0019.
import fs from 'node:fs';
import path from 'node:path';

export function applyRingCapacityOverlay(root) {
  const file = path.join(root, 'src/dxmt/dxmt_command_queue.cpp');
  let source = fs.readFileSync(file, 'utf8');
  const timing = `  auto t0 = clock::now();
  chunk_ongoing.wait(kCommandChunkCount - 1, std::memory_order_acquire);
  chunk_ongoing.fetch_add(1, std::memory_order_relaxed);
  auto t1 = clock::now();
  statistics.commit_interval += (t1 - t0);

`;
  const edits = [
    [timing, ''],
    ['  auto& statistics = CurrentFrameStatistics();\n  statistics.command_buffer_count++;',
      '  statistics.command_buffer_count++;'],
    ['CommandQueue::CommitCurrentChunk() {\n', `CommandQueue::CommitCurrentChunk() {
  auto& statistics = CurrentFrameStatistics();
#if ASYNC_ENCODING
  auto t0 = clock::now();
  for (;;) {
    auto ongoing = chunk_ongoing.load(std::memory_order_acquire);
    while (ongoing >= kCommandChunkCount - 1) {
      chunk_ongoing.wait(ongoing, std::memory_order_acquire);
      ongoing = chunk_ongoing.load(std::memory_order_acquire);
    }
    if (chunk_ongoing.compare_exchange_weak(
            ongoing, ongoing + 1, std::memory_order_acq_rel,
            std::memory_order_acquire))
      break;
  }
  auto t1 = clock::now();
  statistics.commit_interval += (t1 - t0);
#endif

`],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2)
      throw new Error('DXMT ring capacity source changed: src/dxmt/dxmt_command_queue.cpp');
    source = source.replace(before, after);
  }
  fs.writeFileSync(file, source);
}
