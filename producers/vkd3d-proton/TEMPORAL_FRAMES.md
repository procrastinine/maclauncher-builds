# Temporal frames

A temporal frame is one DLSS Super Resolution or Ray Reconstruction evaluation, as the Vulkan driver receives it. It carries the game's images and values to MacLauncher's graphics pipeline. The pipeline selects and runs the upscaler, any effects and frame generation. The frame is information only: a driver that receives it forwards it and does not upscale it itself.

## Structure

`VkTemporalFrameInfoMVK` ([vk_temporal_frame.h](vk_temporal_frame.h)), with `sType` 1000999101, is in the `pNext` chain of a `vkCmdPipelineBarrier2`. KosmicKrisp's `kk_temporal_frame_info` (`kk_temporal.h`) has the same layout.

| Field | Meaning |
| --- | --- |
| `featureId` | The temporal history: one per NGX feature, unique within the process. |
| `frameId` | Greater than 0 and new for every evaluation of the feature. |
| `featureType` | 1 for Super Resolution, 2 for Ray Reconstruction. |
| `images`, `formats` | Slots: color, depth, motion, output, exposure, diffuse albedo, specular albedo, normals, roughness, specular hit distance, HUD-less color and UI. Color, depth, motion and output are required. A format other than `VK_FORMAT_UNDEFINED` is the view to read: integer-typed images are read as the float format of their bits. |
| Offsets and extents | Color, depth and motion are read at their offsets over the render extent, or over the output extent when motion is at display resolution. Output is written at its offset over the output extent. An extent of 0 means the image's extent less the offset. |
| `flags` | Auto exposure 0x1, reset 0x2, reversed depth 0x4, display-resolution motion 0x8, jittered motion 0x10, HDR (linear) color 0x20, valid camera 0x40, infinite far plane 0x80, roughness in normal alpha 0x100. |
| Values | Motion vector scale, jitter offset, pre-exposure (0 means none), sharpness and frame time in milliseconds (0 means unknown). |
| Camera | With the valid-camera flag: positive near and far plane distances (far 0 with an infinite far plane) and the vertical field of view in radians. Ray Reconstruction also has the world-to-view and view-to-clip matrices, row-major, of row vectors. |
| `pReleaseFeatureIds` | Features destroyed since the previous frame. |

## Scene attachments

Drivers bind supplied matrices and AOVs with `rsBindTemporalSceneMatrices` and `rsBindTemporalSceneAovs` before processing the same classic command buffer. Both matrix contracts use row-major row vectors, so supplied finite, nonzero arrays are copied unchanged. Zero or nonfinite matrices remain absent. No clip-range flag is inferred.

The fixed guide conventions follow Streamline `b998246a3d499c08765c5681b229c9e6b4513348`, `docs/ProgrammingGuideDLSS_RR.md` sections 4.1.1–4.1.5 and 4.1.9, and `docs/ProgrammingGuideDLSS_G.md`, “Buffer requirements”. Diffuse and specular albedo are linear material reflectance. Roughness is the material roughness scalar in R, or normal alpha when explicitly flagged. Specular hit distance is a world-space distance; consumers requiring view units decline it without a declared conversion. Normal encoding and view/world space remain unknown because the carrier does not declare them.

HUD-less color follows the backbuffer color space and postprocessing. UI RGB is premultiplied by alpha, with zero alpha outside the UI. The carrier does not declare the backbuffer color domain or the matching composition pass, so those fields remain unknown independently of the SR color contract. Resources are retained with this metadata; consumers requiring an unknown convention decline the attachment. No texture or identity matrix substitutes for absent data.

## Producers

- D3D12: VKD3D-Proton's `ID3D12GraphicsCommandListMetalFX` records the frame in the game's command list, followed by a barrier without the structure.
- D3D11: the NGX core records the frame and the same following barrier in a command buffer of its own. It submits that command buffer on DXVK's queue, after the immediate context's flushed commands, through DXVK's interop interfaces (`IDXGIVkInteropDevice`, `IDXGIVkInteropSurface`).

The NGX core takes the camera from MacLauncher's Streamline proxy, which passes the camera of the game's Streamline constants through the core's `MacLauncherSetTemporalCamera` export as the graphics pipeline's 64-byte `RSTemporalCamera`. An evaluation without Streamline constants has no camera.

## Driver

- **Forwarding.** The driver forwards the frame with `rsProcessTemporalFrame` (graphics `frame.h`). It does this in command order: after every earlier command on the queue has completed, and before any later command starts. The method is `rsGetTemporalMethod`, or MetalFX when none is selected. The driver creates and encodes no MetalFX scaler, interpolator or other upscaler of its own.
- **Command buffer.** The frame goes to a classic `MTLCommandBuffer` (`commandBufferKind` 0) with retained references, before it is committed. Ordered effects and frame generation run only on such a command buffer.
- **Tracked output.** The pipeline writes a tracked texture that the driver keeps for each feature. It has the output extent, private storage and shader-read, shader-write and render-target usage. It is passed with output offsets of 0 and its full extent. After the call, the driver copies it into the frame's output image at the frame's output offset. Frame resources carry no fence, and ordered effects need the complete output texture. A busy frame leaves the previous image in the tracked texture, so the copy always writes a complete image.
- **Owners.** Each `featureId` has one pipeline owner on the device. A released feature ends with `rsReleaseTemporalOwner`, after its last frame has completed.
- **Availability.** `driverInfo` names `temporal-sr` only under two conditions: `rsProcessTemporalFrame`, `rsGetTemporalMethod` and `rsReleaseTemporalOwner` resolve in the process, and MetalFX's temporal scaler supports the device. It names `temporal-rr` only when Ray Reconstruction frames are forwarded. The NGX core offers each DLSS feature only where the device names its word. DLSS Frame Generation is not offered: MacLauncher's frame generation runs from the forwarded Super Resolution frames.
- **No cost without the pipeline.** The symbols are resolved once per process. Without them, the driver names no word and gives frames no handling. A barrier without the structure takes no new path.
- **Synchronous Metal.** Metal objects are created synchronously, without completion handlers.
