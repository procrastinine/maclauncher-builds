// SPDX-License-Identifier: GPL-2.0-only
// A lazily stored depth or stencil plane never stores its results over bytes the CPU wrote after the GPU's last write to
// the plane. A depth surface keeps its rendered stencil (and depth) in the GPU image and stores it to guest memory only
// when that memory is accessed (storeStaleStencil, FlushDepthPlanes). StoreStencilPlane and StoreDepthPlane marked the
// mirror written at store time (MarkWholeWritten or MarkUnitsWritten), so the write-back's CPU check compared against
// the store, not the render: a game that freed the surface and reused its memory for allocator blocks had the CPU's
// newer headers overwritten by the old plane. The surface now records the tracker generation of its last plane write
// (MarkStencilStale, NoteDepthWork), and the stored mirror's results date from it (StorageTexture::ResultsSince), so
// the write-back keeps every 64 KiB block the CPU stamped after the render (logged as keep-newer-cpu).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function applyPlaneStoreKeepsNewerCpuBytes(root) {
  const edit = (relative, change) => {
    const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics', relative);
    let text = fs.readFileSync(file, 'utf8');
    const insert = (anchor, addition, before = false) => {
      assert.equal(text.split(anchor).length, 2, 'plane store source boundary in ' + relative + ': ' + anchor);
      text = text.replace(anchor, () => before ? addition + anchor : anchor + addition);
    };
    change(insert);
    fs.writeFileSync(file, text);
  };
  edit('include/Texture.hpp', insert => {
    insert('    void MarkUnitsWritten(const std::vector<bool>& units);\n',
      '    // The pending results date from `generation` (a lazily stored plane: the GPU\'s last write to it), not from\n' +
      '    // when they were marked written: the write-back keeps the 64 KiB blocks the CPU stamped after it.\n' +
      '    void ResultsSince(std::uint64_t generation);\n');
  });
  edit('src/Texture.cpp', insert => {
    insert('void StorageTexture::MarkWholeWritten() {\n',
      'void StorageTexture::ResultsSince(std::uint64_t generation) {\n' +
      '    if (generation == 0) return;\n' +
      '    for (std::uint32_t layer = 0; layer < trackedLayers; ++layer) {\n' +
      '        if (layerPending[layer] && (layerPendingSince[layer] == 0 || layerPendingSince[layer] > generation)) layerPendingSince[layer] = generation;\n' +
      '    }\n' +
      '}\n\n', true);
  });
  edit('src/DepthSurface.cpp', insert => {
    insert('        stencilMark = nextPlaneSerial();\n', '        stencilStaleGeneration = GuestMemory::TrackerGeneration();\n');
    insert('    void NoteDepthWork() {\n        depthMark = nextPlaneSerial();\n', '        depthStaleGeneration = GuestMemory::TrackerGeneration();\n');
    insert('    std::uint64_t stencilMark = 0;\n',
      '    // Tracker generations of the GPU\'s last depth and stencil plane writes: a lazy plane store keeps CPU blocks newer than them.\n' +
      '    std::uint64_t depthStaleGeneration = 0;\n    std::uint64_t stencilStaleGeneration = 0;\n');
    insert('                surface.depthMark = std::max(surface.depthMark, owner->depthMark);\n',
      '                surface.depthStaleGeneration = std::max(surface.depthStaleGeneration, owner->depthStaleGeneration);\n');
    insert('                surface.stencilMark = std::max(surface.stencilMark, owner->stencilMark);\n',
      '                surface.stencilStaleGeneration = std::max(surface.stencilStaleGeneration, owner->stencilStaleGeneration);\n');
    insert('        stencilMirror.storage->MarkWholeWritten();\n', '        stencilMirror.storage->ResultsSince(stencilStaleGeneration);\n');
    insert('            mirror->MarkWholeWritten();\n', '            mirror->ResultsSince(depthStaleGeneration);\n');
    insert('        mirror->MarkUnitsWritten(units);\n', '        mirror->ResultsSince(depthStaleGeneration);\n');
  });
}
