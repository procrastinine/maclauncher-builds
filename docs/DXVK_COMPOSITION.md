# DXGI composition

The adapted DXVK renderer includes a paired DirectComposition library. Opaque composition swapchains present to a native child surface attached to the target HWND when its visual tree is committed. Presentation uses the renderer’s ordinary Vulkan swapchain; no image readback or copy is required. HWND swapchains use the upstream presentation path.

The composition device supports one swapchain visual per target, offsets, translation and rectangular clips. Unsupported visual effects, child visual trees, animation and per-pixel alpha return errors. Unbinding content hides its surface, and releasing the swapchain destroys that surface after its Vulkan presenter. The surface never takes keyboard focus or consumes mouse hit tests.

`dxgi.dll` imports the paired `dcomp.dll` through the native `MCLCompositionCreateWindow` entry. Both belong to the renderer’s physical binding group. The shared private COM interface is identified by its fixed IID; it binds committed content to the actual target window. The DLLs are selected and prepared together through ordinary PE dependency facts.

Pipeline compilation, descriptor selection and cache environment controls are specified in [DXVK adaptations](DXVK_ADAPTATIONS.md).

## Source and build

DXVK is an exact Git submodule from [the original project](https://github.com/doitsujin/dxvk). Its nested source pins remain upstream-owned. Owned composition code and the projection are under `producers/dxvk/`; upstream checkouts stay unchanged.

The producer builds the complete renderer and companion for Windows x86 and x64 using LLVM-MinGW, Meson, Ninja and glslang. The declared source and nested submodules are initialized before building. An existing compatible host glslang can be reused; source builds use the shared `glslangNx` pin in `producers/dependencies.json`.

```sh
node producers/dxvk/build.mjs --work /build/work --output /build/payload \
  --mingw /tools/llvm-mingw/bin --glslang /tools/glslang
```

The runtime layout is `x32/` and `x64/`, matching upstream DXVK. Each architecture contains the renderer DLLs and paired `dcomp.dll`; source notices are collected with the runtime.

The registered `dxvk` project produces one universal archive containing both Windows targets. Its package floor follows the launcher’s macOS 13 floor; the selected Wine host and Vulkan driver retain their own requirements. The ordinary build wrapper acquires the declared LLVM-MinGW archive and initializes the exact DXVK source and nested dependencies.
