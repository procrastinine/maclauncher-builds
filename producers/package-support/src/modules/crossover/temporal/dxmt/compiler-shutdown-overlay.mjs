// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from SteveTanSaMa's DXMT compiler lifetime fix, origin
// def87758c04e635f4cad90d0dda1defa91bc7661, as carried by fxgl/steamac
// 32a66354a24cc62d4c9ec1d263c5df7a0b1e1d7e, host/dxmt/patches/0010.
import fs from 'node:fs';
import path from 'node:path';

export function applyCompilerShutdownOverlay(root) {
  const edits = [
    ['src/d3d11/d3d11_pipeline_cache.cpp', 'public:\n  PipelineCache(MTLD3D11Device *pDevice) :', `public:
  ~PipelineCache() override {
    // Members are destroyed in reverse declaration order. Join workers while
    // shader variants, pipelines and their dependencies are still alive.
    scheduler_.shutdown();
  }

  PipelineCache(MTLD3D11Device *pDevice) :`],
    ['src/dxmt/dxmt_tasks.hpp', '  ~task_scheduler();', `  ~task_scheduler();
  // Called by the owner before destroying the objects referenced by tasks.
  // Queued work may be abandoned; running work is joined before returning.
  void shutdown();`],
    ['src/dxmt/dxmt_tasks.hpp', `template <typename Task> task_scheduler<Task>::~task_scheduler() {
  destroyed.store(true);`, `template <typename Task> task_scheduler<Task>::~task_scheduler() {
  shutdown();
}

template <typename Task> void task_scheduler<Task>::shutdown() {
  {
    std::lock_guard<dxmt::mutex> lock(worker_mutex_);
    destroyed.store(true);
  }`],
    ['src/dxmt/dxmt_tasks.hpp', '      if (!task_continuation_queue_.empty()) {', `      if (destroyed.load())
        break;

      if (!task_continuation_queue_.empty()) {`],
    ['src/dxmt/dxmt_tasks.hpp', `  std::unique_lock<dxmt::mutex> lock(worker_mutex_);
  task_queue_.push(task);`, `  std::unique_lock<dxmt::mutex> lock(worker_mutex_);
  if (destroyed.load())
    return;
  task_queue_.push(task);`],
  ];
  const sources = new Map();
  for (const [relative, before, after] of edits) {
    const file = path.join(root, relative);
    const source = sources.get(file) ?? fs.readFileSync(file, 'utf8');
    if (source.split(before).length !== 2)
      throw new Error('DXMT compiler shutdown source changed: ' + relative);
    sources.set(file, source.replace(before, after));
  }
  for (const [file, source] of sources) fs.writeFileSync(file, source);
}
