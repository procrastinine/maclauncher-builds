# Scene adapters

The scene adapters record work alongside the original game graphics calls. Each has its own recipe, `tools/build-winevulkan-scene.mjs`, `tools/build-fidelityfx-api.mjs` or `tools/build-vulkan-moltenvk-scene.mjs`, and they share the llvm-mingw toolchain and packaging steps in `tools/scene-runtime.mjs`. All three use the shared Runtime build workflow. The registered version selects its source profile and compiler inputs.

The WineVulkan and MoltenVK recipes run in three steps. Preparation downloads the declared archives and toolchain or fetches the declared sources and projects the adapted source without compiling. The compile step (`--phase compile`) builds the libraries, including Bison for WineVulkan, and stages them as shipped: the Windows modules without debug sections and the native module signed, or each MoltenVK CPU slice under its scene library name with its install name and signature. The assemble step (`--phase assemble`) writes the licenses, provider descriptor, manifest and declaration from those libraries and the prepared sources alone. Without `--phase` a recipe runs all three steps.

| Package | Version | CPU | Minimum macOS | Inputs |
| --- | --- | --- | --- | --- |
| WineVulkan scene adapter | 26.3.0-MCLv1 | Intel; Rosetta on Apple Silicon | 10.15 | CrossOver 26.3 Wine source, Bison 3.8.2, LLVM-MinGW, MoltenVK 1.4.2 link input |
| FidelityFX API adapter | 1.0.1-MCLv8 | Windows x64 DLLs | 10.15 host | FidelityFX SDK 1.1.4, Vulkan-Headers 1.4.335, the VKD3D-Proton producer's carrier headers, LLVM-MinGW |
| MoltenVK scene adaptation | 1.4.2-MCLv10 | Universal | 13 | MoltenVK 1.4.2, SPIRV-Cross, Vulkan-Headers and cereal |

WineVulkan builds the original native module and both Windows forwarding modules, with the scene recording additions. Its recipe checks the complete original export set. The declared MoltenVK library supplies Wine's configure link probe and is not included in the package.

FidelityFX builds one proxy for each of the SDK's signed API libraries, `amd_fidelityfx_vk.dll` and `amd_fidelityfx_dx12.dll`. The source profile identifies each library by path and digest, and the recipe gives each proxy that library's five exports and ordinals. At run time a proxy loads the game's own library, renamed beside it, and records each upscale dispatch as a temporal frame (`VkTemporalFrameInfoMVK` with `VkTemporalFrameMasksInfoMVK`): in the Vulkan command buffer when the device's `driverInfo` names `temporal-sr`, or through VKD3D-Proton's `ID3D12GraphicsCommandListMetalFX` for Direct3D 12. A dispatch that cannot be recorded runs the original. The package contains both proxies, a schema 2 provider descriptor with one entry per backend, and license notices; the SDK libraries stay in the producer output.

MoltenVK builds each CPU slice from the same source profile, combines them into one library and includes its dependency notices. Its scene operations use the original Metal command buffer and prepared tracked resources. It forwards temporal frames (`VkTemporalFrameInfoMVK`) from VKD3D-Proton and the NGX core to MacLauncher graphics, with their scene matrices, AOVs and chained reactive and transparency masks (`VkTemporalFrameMasksInfoMVK`), following the driver contract in [Temporal frames](../producers/vkd3d-proton/TEMPORAL_FRAMES.md#driver). Its `driverInfo` names `temporal-sr` only when the graphics entry points resolve in the process and the device supports MetalFX temporal scaling.

The [verification guide](../VERIFYING.md) explains build records and rebuild comparison. A build record covers the MoltenVK configure input; it does not establish how that publisher binary was compiled.

MoltenVK uses its device residency set instead of enumerating every device-address buffer at each encoder. Residency-backed queues encode submissions asynchronously by default; `MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS=1` selects synchronous encoding. Devices without a residency set retain synchronous encoding and per-encoder resource declarations. Residency-backed device-address accesses use the application's Vulkan barriers for synchronization.
