import {sourceRevision} from '../../../../../../../lib/pins.mjs';
import {appPath} from '../../../../../../../tools/app-source.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export const source=JSON.parse(fs.readFileSync(path.join(root,'moltenvk-scene-source.json')));
export const ownedFiles=['scene-interop.h','scene-command.hpp','scene-command.inc'];
export const commonHeaders={
 'frame.h':'../../reshade/temporal/frame.h',
 'scene-aovs.h':'../../reshade/temporal/scene-aovs.h',
 'scene-matrices.h':'../../reshade/temporal/scene-matrices.h',
 'image-color.h':'../../reshade/native/image-color.h',
 'vulkan-scene.h':'../../reshade/native/vulkan-scene.h'
};
function original(repository,file){return execFileSync('git',['-C',repository,'show',sourceRevision(source)+':'+file],{encoding:'utf8',env:{...process.env,GIT_NO_LAZY_FETCH:'1'},maxBuffer: Infinity});}
function replace(text,from,to,file){if(text.split(from).length!==2)throw Error('MoltenVK source anchor changed: '+file);return text.replace(from,to);}
// Apache-2.0 adaptation of Highball 53741235af002eac43a214c347864ad83dbceb8d.
// Author: Gauthier Piarrette <gauthierpiarrette@gmail.com>, 2026-10-12.
// Source: https://github.com/gauthierpiarrette/highball-engine
// moltenvk-arm64/moltenvk/0001-Bind-a-descriptor-set-again-after-MoltenVK-s-own-hel.patch
// at 161d7a8495d041d2901d07ff3b4fffeed9be1a4b. Upstream MoltenVK notices are retained.
export function descriptorBindingSource(text){
 const file='MoltenVK/MoltenVK/Commands/MVKCommandEncoderState.mm';
 const invalidate='\tif (index < kMVKMaxDescriptorSetCount) { exists.descriptorSetData.clear(index); }\n';
 // Helpers replace the argument buffer at a descriptor set's Metal buffer index.
 const assertion='\tassert(index < kMVKMaxBufferCount);\n';
 for(const name of ['bindBuffer','bindBytes']){
  const start=text.indexOf('static void '+name+'('),end=text.indexOf('\n}',start);
  if(start<0||end<0)throw Error('MoltenVK source anchor changed: '+file+' '+name);
  const body=text.slice(start,end);
  text=text.slice(0,start)+replace(body,assertion,assertion+invalidate,file)+text.slice(end);
 }
 const restore='\texists.descriptorSetData |= resources.resources.descriptorSetData;\n';
 text=replace(text,restore,'',file);
 const loopEnd='\t\tbindBuffer(encoder, set->gpuBufferObject, set->gpuBufferOffset, idx, exists, bindings, binder);\n\t}\n';
 // Restore the set bits after bindBuffer invalidates each index in the loop.
 return replace(text,loopEnd,loopEnd+restore,file);
}
// Apache-2.0 adaptation by Gauthier Piarrette, 2026-10-16.
// https://github.com/gauthierpiarrette/highball-engine at 161d7a8495d041d2901d07ff3b4fffeed9be1a4b,
// moltenvk-arm64/moltenvk/0014-Copy-every-partial-edge-block-of-a-compressed-image.patch.
export function compressedCopySource(text){
 return replace(text,
  '                dstExtent.width /= srcBlockExtent.width;\n                dstExtent.height /= srcBlockExtent.height;',
  '                // Partial edge blocks still occupy a complete destination texel.\n'+
  '                dstExtent.width = mvkCeilingDivide(dstExtent.width, srcBlockExtent.width);\n'+
  '                dstExtent.height = mvkCeilingDivide(dstExtent.height, srcBlockExtent.height);',
  'MoltenVK/MoltenVK/Commands/MVKCmdTransfer.mm');
}
export function sceneSources(repository,readSource=file=>original(repository,file)){
 const files=new Map();
 const edit=(file,changes)=>{let text=readSource(file);for(const[from,to]of changes)text=replace(text,from,to,file);files.set(file,text);};
 const commands='MoltenVK/MoltenVK/Commands/';
 const bindings=commands+'MVKCommandEncoderState.mm';
 files.set(bindings,descriptorBindingSource(readSource(bindings)));
 const transfer=commands+'MVKCmdTransfer.mm';
 files.set(transfer,compressedCopySource(readSource(transfer)));
 edit(commands+'MVKCommandPool.h',[
  ['#include "MVKCmdDebug.h"','#include "MVKCmdDebug.h"\n#include "scene-command.hpp"'],
  ['#pragma mark Command resources','MVKCommandTypePool<MVKCmdMacfxScene> _cmdMacfxScenePool;\n\n#pragma mark Command resources']
 ]);
 edit(commands+'MVKCommandPool.mm',[
  ['void MVKCommandPool::trim() {','void MVKCommandPool::trim() {\n    _cmdMacfxScenePool.clear();'],
  ['\t_commandBufferPool(device, usePooling),','\t_cmdMacfxScenePool(usePooling),\n\t_commandBufferPool(device, usePooling),']
 ]);files.set(commands+'MVKCommandPool.mm',files.get(commands+'MVKCommandPool.mm')+'\n#include "scene-command.inc"\n');
 edit(commands+'MVKCommandBuffer.h',[
  ['\tvoid addCommand(MVKCommand* command);','\tvoid addCommand(MVKCommand* command);\n    bool canRecordMacfxSceneOperation() const { return _canAcceptCommands; }\n    bool canRecordMacfxSceneStaging() const { return _canAcceptCommands && !_immediateCmdEncoder && (!_prefilledMTLCmdBuffer || _prefilledMTLCmdBuffer.retainedReferences); }\n    bool _macfxSceneStaging=false, _macfxSceneStagingEscaped=false;']
 ]);
 edit(commands+'MVKCommandBuffer.mm',[
  ['VkResult MVKCommandBuffer::reset(VkCommandBufferResetFlags flags) {','VkResult MVKCommandBuffer::reset(VkCommandBufferResetFlags flags) {\n    _macfxSceneStaging = _macfxSceneStagingEscaped = false;'],
  ['\t\tif (cmdBuff->_hasStageCounterTimestampCommand) { _hasStageCounterTimestampCommand = true; }','\t\tif (cmdBuff->_hasStageCounterTimestampCommand) { _hasStageCounterTimestampCommand = true; }\n        if (cmdBuff->_macfxSceneStaging) {\n            _macfxSceneStaging = true;\n            _macfxSceneStagingEscaped = _macfxSceneStagingEscaped || _immediateCmdEncoder || cmdBuff->_macfxSceneStagingEscaped;\n        }']
 ]);
 {
  const file=commands+'MVKCommandBuffer.mm',guard='if (!isUsingMetalArgumentBuffers() || !getDevice()->hasResidencySet()) return;';
  let text=files.get(file);
  if(text.split(guard).length!==7)throw Error('MoltenVK barrier guard count changed');
  text=text.replaceAll(guard,'if ((!isUsingMetalArgumentBuffers() || !getDevice()->hasResidencySet()) && !_cmdBuffer->_macfxSceneStaging) return;');
  const index='auto fenceIndex = _pEncodingContext->fenceSlots.wait[stage][i];';
  if(text.split(index).length!==4)throw Error('MoltenVK barrier wait count changed');
  // Index zero belongs to the original cross-submission residency path. The
  // opt-in boundary uses only producer fences updated in this recording.
  text=text.replaceAll(index,index+'\n        if (!fenceIndex && (!isUsingMetalArgumentBuffers() || !getDevice()->hasResidencySet())) continue;');
  files.set(file,text);
 }
 edit('MoltenVK/MoltenVK/GPUObjects/MVKDevice.mm',[
  ['#include "MVKDevice.h"','#include "MVKDevice.h"\n#include "scene-interop.h"'],
  ['void MVKDevice::encodeGPUAddressableBuffers(MVKUseResourceHelper& resources, MVKResourceUsageStages stage) {',
   'void MVKDevice::encodeGPUAddressableBuffers(MVKUseResourceHelper& resources, MVKResourceUsageStages stage) {\n    // Residency sets already cover device-address allocations (AnyPS5-ARM 199bca7c07).\n    if (hasResidencySet()) return;'],
  ['PFN_vkVoidFunction MVKDevice::getProcAddr(const char* pName) {','PFN_vkVoidFunction MVKDevice::getProcAddr(const char* pName) {\n    if (pName && !strcmp(pName, "rsMoltenVKSceneOperationAPI")) return (PFN_vkVoidFunction)rsMoltenVKSceneOperationAPI;\n    if (pName && !strcmp(pName, "rsMoltenVKSceneStagingAPI")) return (PFN_vkVoidFunction)rsMoltenVKSceneStagingAPI;\n    if (pName && !strcmp(pName, "rsMoltenVKRecordSceneOperation")) return (PFN_vkVoidFunction)rsMoltenVKRecordSceneOperation;']
 ]);
 edit('MoltenVK/MoltenVK/GPUObjects/MVKDevice.h',[
  ['class MVKDevice : public MVKDispatchableVulkanAPIObject {', 'class MVKDevice : public MVKDispatchableVulkanAPIObject {\npublic:\n    std::atomic<uint32_t> _macfxSceneRecordingCount{0};']
 ]);
 edit('MoltenVK/MoltenVK/GPUObjects/MVKQueue.mm',[
  ['if ( !getMVKConfig().synchronousQueueSubmits ) {','if ( !getMVKConfig().synchronousQueueSubmits && _device->hasResidencySet() ) {'],
  ['mtlCmdBuffDesc.retainedReferences = retainRefs;', 'mtlCmdBuffDesc.retainedReferences = retainRefs || _device->_macfxSceneRecordingCount.load(std::memory_order_acquire) != 0;']
 ]);
 edit('MoltenVK/CMakeLists.txt',[['COMMAND ${GIT_EXECUTABLE} rev-parse --short HEAD','COMMAND ${CMAKE_COMMAND} -E echo db66022459ff']]);
 // The scene headers are app source: they are read from the pinned app checkout.
 const shared=appPath('src/modules/shared/vulkan/native');
 for(const file of ownedFiles)files.set(commands+file,fs.readFileSync(path.join(shared,file)));
 files.set('MoltenVK/include/MoltenVK/scene-interop.h',fs.readFileSync(path.join(shared,'scene-interop.h')));
 for(const[name,file]of Object.entries(commonHeaders))files.set('MoltenVK/include/macfx-temporal/'+name,fs.readFileSync(path.resolve(shared,file)));
 return files;
}
