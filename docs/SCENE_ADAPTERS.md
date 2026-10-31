# Scene adapters

The scene adapters record work alongside the original game graphics calls. Each has its own recipe, `tools/build-winevulkan-scene.mjs`, `tools/build-fidelityfx-api.mjs` or `tools/build-vulkan-moltenvk-scene.mjs`, and they share the llvm-mingw toolchain and packaging steps in `tools/scene-runtime.mjs`. All three use the shared Runtime build workflow. The registered version selects its source profile, compiler inputs and required notices.

| Package | Version | CPU | Minimum macOS | Inputs |
| --- | --- | --- | --- | --- |
| WineVulkan scene adapter | 26.3.0-MCLv1 | Intel; Rosetta on Apple Silicon | 10.15 | CrossOver 26.3 Wine source, Bison 3.8.2, LLVM-MinGW, MoltenVK 1.4.2 link input |
| FidelityFX API adapter | 1.0.1-MCLv1 | Windows x64 DLL | 10.15 host | FidelityFX SDK 1.1.4, pinned Vulkan headers from SDL, LLVM-MinGW |
| MoltenVK scene adaptation | 1.4.2-MCLv2 | Universal | 13 | MoltenVK 1.4.2, SPIRV-Cross, Vulkan-Headers and cereal |

WineVulkan builds the original native module and both Windows forwarding modules, with the scene recording additions. Its recipe checks the complete original export set. The declared MoltenVK library supplies Wine's configure link probe and is not included in the package.

FidelityFX preserves the original SDK Vulkan DLL beside its forwarding DLL. The source profile identifies that DLL by path and digest, and the recipe checks its version and exports. The package contains the DLL pair, its provider descriptor and license notices. The native Vulkan scene source archive is a separate producer output used by the graphics package.

MoltenVK builds each CPU slice from the same source profile, combines them into one library and includes its dependency notices. Its scene operations use the original Metal command buffer and prepared tracked resources.

The [verification guide](../VERIFYING.md) explains build records and rebuild comparison. A build record covers packaging of the original FidelityFX DLL and the MoltenVK configure input; it does not establish how those publisher binaries were compiled.
