// SPDX-License-Identifier: MIT
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
/** Apply owned patches only to the producer's disposable source projection. */
export function applyAdaptations(source) {
  for (const name of ['kosmickrisp-fast-link.patch', 'kosmickrisp-descriptor-heap.patch', 'async-opt-in.patch', 'd3d9-feedback-copy.patch', 'dxgi-flip-buffer-count.patch'])
    execFileSync('git', ['apply', '--unsafe-paths', '--directory=' + path.resolve(source),
      path.join(import.meta.dirname, 'patches', name)], {cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'inherit'});
  if (!fs.readFileSync(path.join(source, 'src/dxvk/dxvk_device.cpp'), 'utf8').includes('&& m_properties.extGraphicsPipelineLibrary.graphicsPipelineLibraryFastLinking')
   || !fs.readFileSync(path.join(source, 'src/dxvk/dxvk_graphics.cpp'), 'utf8').includes('m_asyncPending.push_back(state)')
   || !fs.readFileSync(path.join(source, 'src/d3d9/d3d9_device.cpp'), 'utf8').includes('D3D9DeviceEx::GetRenderTargetSnapshot(')
   || !fs.readFileSync(path.join(source, 'src/dxgi/dxgi_factory.cpp'), 'utf8').includes('pDesc->BufferCount < 2 || pDesc->BufferCount > DXGI_MAX_SWAP_CHAIN_BUFFERS'))
    throw Error('DXVK adaptations were not applied to the source projection.');
}
