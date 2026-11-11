import fs from 'node:fs';
import path from 'node:path';

// DXMT 7c8dee1 constructs ClearUAV before the device it reads through its
// parent context. C++ initializes members in declaration order.
export function applyStartupOverlay(root) {
  const edits = [
    ['src/dxmt/dxmt_context.hpp', 'private:\n  template <PipelineStage stage> void track',
      'private:\n  WMT::Device device_;\n  template <PipelineStage stage> void track'],
    ['src/dxmt/dxmt_context.hpp', '  WMT::Device device_;\n  CommandQueue& queue_;', '  CommandQueue& queue_;'],
    ['src/dxmt/dxmt_context.cpp', '    lib(lib),', '    device_(device),\n    lib(lib),'],
    ['src/dxmt/dxmt_context.cpp', '    timestamp_state_(device),\n    device_(device),', '    timestamp_state_(device),'],
  ];
  for (const [relative, before, after] of edits) {
    const file = path.join(root, relative), source = fs.readFileSync(file, 'utf8');
    if (source.split(before).length !== 2) throw new Error('DXMT startup source changed: ' + relative);
    fs.writeFileSync(file, source.replace(before, after));
  }
}
