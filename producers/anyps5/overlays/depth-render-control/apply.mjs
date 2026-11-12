// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 draw precheck source changed: ' + before.slice(0, 100));
  return source.replace(before, after);
}

// NoteDepthRenderControl records DB_RENDER_CONTROL only on native multisample depth surfaces, so a
// single-sample depth target's clear or expand bits neither drain the draw pipeline nor take the note.
export async function applyDepthRenderControlOverlay(root) {
  const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Execution/src/Driver/Draw/DrawPrecheck.cpp');
  const source = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, replace(source,
    '    if (const auto control = Graphics::DecodeDepthRenderControl(queue); control && Graphics::DepthRenderControlDrains(*control)) {\n',
    '    // Only native multisample depth surfaces record the render control (NoteDepthRenderControl).\n    if (const auto control = Graphics::DecodeDepthRenderControl(queue); control && control->samples != 1u && Graphics::DepthRenderControlDrains(*control)) {\n'));
}
