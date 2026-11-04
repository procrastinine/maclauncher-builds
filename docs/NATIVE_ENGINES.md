# FNA, OpenGMK, npengine and Impacto

These game hosts use the [Runtime build workflow](../.github/workflows/runtime-build.yml). Each project's build record in [the downloadable registry](../projects/downloadable.json) names its command, package version, CPU and build tools. The commands fetch exact public source revisions and checked archives, compile into a separate directory and pass their outputs to the shared package sealer. The sealer copies library dependencies and notices, measures the complete macOS requirement and checks the finished signatures.

The registered profiles build for Apple Silicon and target macOS 13. Their package manifests record the measured requirement. The SDK used for compilation is a separate value.

| Project | Source and dependencies | Command |
| --- | --- | --- |
| FNA | FNA 26.10, its pinned Git dependencies, the selected FNA3D revision, SDL 3.4.18 and .NET 8.0.32 | `tools/build-fna.mjs` |
| OpenGMK | OpenGMK 0.2.0, exact ramen and udon revisions, the AppKit and CoreAudio overlays and a checked-in Cargo lock | `tools/build-opengmk.mjs` |
| npengine | libnpengine 0.5.3, libnpa, SDL2, source-built Boost and GLEW, and the official GStreamer 1.28.7 SDK files | `tools/build-npengine.mjs` |
| Impacto | The Windows-game profile of Impacto 0.10.8.903, source-built fonts, audio and graphics dependencies, FFmpeg with the Bink2 patch, avcpp, LibAtrac9 and magic_enum | `tools/build-impacto.mjs` |

A build uses a new output directory and a separate new work directory. For example:

```sh
node tools/build-runtime.mjs --project opengmk --arch arm64 \
  --output /absolute/path/to/package --work /absolute/path/to/build
```

The workflow initializes any source submodules in the project record and installs its declared build tools. These source commands fetch upstream Git revisions into their work directories. Ordinary package installation does not need these build tools or source checkouts.

## FNA

The recipe compiles FNA, the managed game host and the XNA facade assemblies with the pinned Roslyn compiler and .NET reference pack. It builds SDL3, FNA3D and FAudio from source and packages the matching .NET runtime. The runtime archive is a Microsoft input; GitHub provenance for the finished package describes the package build rather than Microsoft's compilation of .NET. The runtime profile remains separate from the package revision, so repackaging keeps its framework and game ABI identity.

The managed host runs a game from its original directory. `MACLAUNCHER_FNA_GAME_ROOT` names that directory, which becomes the working directory and the base directory FNA uses for content. Game assemblies resolve first from `MACLAUNCHER_FNA_ASSEMBLY_ROOT`, which holds only copies retargeted for ARM64, and then from the original directory, including culture subdirectories for satellite assemblies. Upstream launchers such as MonoKickstart search only the game directory; the earlier assembly root is MacLauncher's addition for the retargeted copies. With `MACLAUNCHER_FNA_USE_RUNTIME_FRAMEWORK=1`, FNA and the XNA facades load from the package; otherwise the game's own FNA loads. The host's dependency file lists only the host, so the CLR does not bind the package's `FNA.dll` before the host chooses. The game assembly becomes the process entry assembly, as in a direct launch, so FNA names its storage folder and default window title after the game and code that locates content from the entry assembly finds the game's own location. SDL3, FNA3D and FAudio load from the package; an assembly that sets its own native library resolver, as FNA built for .NET 7 or later does, keeps it. Packages with this behavior record `capabilities.originalGamePaths` as `true` both in `fna-runtime.json` and in their catalog records. The host requires `MACLAUNCHER_FNA_GAME_ROOT`.

Component licence texts use the shared [licence intake](SOURCE_PINS.md#licences) from available source directories.

## OpenGMK

The recipe keeps the upstream checkouts unchanged and applies the Mac adaptations to owned copies. The ramen window backend uses AppKit, the renderer uses OpenGL and the udon audio dependency uses CoreAudio. Cargo uses [the declared lock](../producers/maclauncher/helper-builds/opengmk.lock) with `--locked`.

The shared licence intake reads available Cargo source directories. Missing or unreadable texts produce a warning and do not stop packaging.

## npengine

The recipe reconstructs the exact GStreamer SDK subset from checksum-verified byte ranges in the official runtime and development installers. It decodes their package payloads and selects only the files in the producer's SDK declaration. It does not install a system framework. The native runner, script compiler, Boost locale library, GLEW and SDL2 are compiled from their declared sources.

## Impacto

The recipe builds its portable dependency set before the current Windows-game profile. The codec build applies the declared Bink2 patch to FFmpeg and builds avcpp against that output. The producer checks the codec headers and linked libraries together before it compiles the game host. Upstream source checkouts remain unchanged; patches and generated files belong to the build directories.

[Verifying packages](../VERIFYING.md) describes GitHub build records and rebuild comparisons. [Runtime packages](PACKAGES.md) describes the package format and installation metadata.
