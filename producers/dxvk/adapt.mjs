// SPDX-License-Identifier: MIT
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
/** Apply owned patches only to the producer's disposable source projection. */
export function applyAdaptations(source) {
  for (const name of ['kosmickrisp-fast-link.patch', 'kosmickrisp-descriptor-heap.patch', 'async-opt-in.patch'])
    execFileSync('git', ['apply', '--unsafe-paths', '--directory=' + path.resolve(source),
      path.join(import.meta.dirname, 'patches', name)], {cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'inherit'});
  if (!fs.readFileSync(path.join(source, 'src/dxvk/dxvk_device.cpp'), 'utf8').includes('&& m_properties.extGraphicsPipelineLibrary.graphicsPipelineLibraryFastLinking')
   || !fs.readFileSync(path.join(source, 'src/dxvk/dxvk_graphics.cpp'), 'utf8').includes('m_asyncPending.push_back(state)'))
    throw Error('DXVK adaptations were not applied to the source projection.');
}
