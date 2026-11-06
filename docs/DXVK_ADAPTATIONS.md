# DXVK adaptations

The renderer contains DXVK 3.1.1, the paired DirectComposition implementation described in [DXGI composition](DXVK_COMPOSITION.md), and the owned patches under producers/dxvk/patches. The producer applies patches to a disposable source copy. Original sources remain unchanged.

## Pipeline compilation

Graphics pipeline libraries require the advertised graphicsPipelineLibrary feature, independent interpolation decorations, and graphicsPipelineLibraryFastLinking property. This applies to every driver. Without fast linking, DXVK uses monolithic graphics pipelines. dxvk.enableGraphicsPipelineLibrary=False disables libraries; True still requires these capabilities. Auto retains upstream background optimization when libraries are available.

Async compilation is disabled by default. DXVK_ASYNC=1 supplies the default for dxvk.enableAsync; an explicit dxvk.conf value takes precedence. dxvk.enableAsync=True enables background compilation of eligible monolithic graphics pipelines. A pipeline that can fast-link keeps the ordinary library path. Explicit dxvk.enableGraphicsPipelineLibrary=True keeps upstream compilation behavior.

Async compilation skips draws until their pipeline is ready. Objects and effects can appear late, and skipped passes can affect subsequent rendering. Eligibility requires attachments used across at least five consecutive frame transitions; it does not guarantee visual correctness. Async rendering can interact with anti-cheat systems and is unsuitable for titles that prohibit modified rendering. Compute compilation retains upstream behavior.

The implementation derives from [dxvk-gplasync](https://gitlab.com/Ph42oN/dxvk-gplasync/-/tree/04e50ed2c4dee43e64d30119b2c5b26a23e2b6a4), patch dxvk-gplasync-3.1.1-1.patch. The original patch is retained for attribution; async-opt-in.patch is the applied adaptation. It tracks unchanged render targets on every draw, synchronizes shared view history, and keeps one pending job per graphics state.

## Descriptors

KosmicKrisp joins DXVK's descriptor heap Auto allow-list. VK_EXT_descriptor_heap and descriptorHeap must be advertised. dxvk.enableDescriptorHeap=False retains precedence. The existing descriptor-buffer selection remains unchanged; when neither selected path is available DXVK uses classic descriptor sets. No extension or feature is fabricated.

## Cache environment

DXVK_SHADER_CACHE_PATH selects the shader IR cache directory. For a launcher-owned runtime directory the integration supplies a Wine-visible absolute path to cache/dxvk, alongside Mesa's cache/mesa directory selected by MESA_SHADER_CACHE_DIR. The DXVK setting takes a Windows path in the PE renderer, so a host POSIX path must be translated through the Wine host's existing path mapping.

DXVK 3.1.1 writes a 16-digit executable-path hash followed by .dxvk.bin (shader data) and .dxvk.lut (lookup table). Without an override, the Windows build tries LOCALAPPDATA/dxvk, then XDG_CACHE_HOME/dxvk, then HOME/.cache/dxvk. It does not write the old per-game .dxvk-cache state files. DXVK_STATE_CACHE_PATH applies to older renderer versions and does not relocate the 3.1.1 cache.

## Exact source inputs

| Input | Public origin | Commit |
| --- | --- | --- |
| DXVK | https://github.com/doitsujin/dxvk | b1a1c99ab52b687cf950d62c88bc2fa316b41663 |
| DirectX headers | https://github.com/Joshua-Ashton/mingw-directx-headers | 9df86f2341616ef1888ae59919feaa6d4fad693d |
| Vulkan-Headers | https://github.com/KhronosGroup/Vulkan-Headers | 8864cdc896bbc2a9b6eb36b3218fc9ef57908d77 |
| SPIRV-Headers | https://github.com/KhronosGroup/SPIRV-Headers | 04f10f650d514df88b76d25e83db360142c7b174 |
| DXBC-SPIRV | https://github.com/doitsujin/dxbc-spirv | bf14419e5fa7eacb817b7b632f03cb61d61bbad7 |
| DXBC-SPIRV nested SPIRV-Headers | https://github.com/KhronosGroup/SPIRV-Headers | c8ad050fcb29e42a2f57d9f59e97488f465c436d |
| libdisplay-info | https://github.com/doitsujin/libdisplay-info | 275e6459c7ab1ddd4b125f28d0440716e4888078 |
| glslang (host compiler) | https://github.com/KhronosGroup/glslang | ba1640446f3826a518721d1f083f3a8cca1120c3 |
| Async patch | https://gitlab.com/Ph42oN/dxvk-gplasync | 04e50ed2c4dee43e64d30119b2c5b26a23e2b6a4 |

LLVM-MinGW 20261006 uses the checksum-pinned archive declared in producers/dxvk/inputs.json. The producer builds Windows x64 and x86. The renderer and its companion retain their source notices.
