# AnyPS5

[AnyPS5](https://github.com/boykopovar/AnyPS5) converts PS5 executables and their bundled modules into executable formats of the host system. The macOS package has a conversion tool called the relinker for its selected CPU, and x86-64 Mach-O system libraries for the converted games. The games run natively on Intel Macs and through Rosetta on Apple Silicon. MacLauncher's [PlayStation 5](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/PS5.md) page describes how games use the runtime.

The AnyPS5 source is the submodule [`sources/anyps5`](../sources/anyps5), fixed at an exact commit, and the build recipes never modify that checkout. `producers/anyps5/dependencies.json` records the exact commit and public repository URL of every Git dependency the runtime uses.

Each build copies the tracked files into a disposable working copy, called the source projection, and applies this repository's changes to it in a fixed order; each change first checks that the upstream code it adapts still matches. When a projection is synchronized again, files that no longer exist are removed and unchanged files keep their timestamps. Compiler output goes to a separate build directory.

## Conversion tool

The [relinker recipe](../producers/anyps5/source.json) builds the conversion tool with CMake and an Apple C++20 toolchain. It shares the [projection script](../producers/anyps5/source-projection.mjs) with the runtime recipe described below, and its projection adds an adapter for Darwin image metadata.

```sh
git submodule update --init sources/anyps5
node producers/anyps5/build-relinker.mjs --check
node producers/anyps5/build-relinker.mjs --jobs 4
```

The default build directory is `out/anyps5-relinker`. `--arch arm64` or `--arch x64` selects the conversion tool's CPU; the default is the build host's CPU. `--build-dir` selects another absolute output directory, which must be outside the upstream checkout. The projection is written to the build directory's `source` subdirectory, and the executable is built at `core/relinker/relinker`. A build directory configured against a different source root cannot be reused, so that build needs its own output directory.

`--check` verifies the checkout's commit and repository URL without creating build outputs. A full build ends by running the relinker with `--help`, and it does not need the third-party submodules.

Both tool builds produce x86-64 game executables: `--macos` selects Mach-O output, and `--to-rosetta` applies the supported x86 instruction substitutions. A converted game also needs host implementations of the system libraries, which the upstream relinker-only target leaves out and the macOS runtime recipe provides.

## macOS runtime

The [runtime recipe](../producers/anyps5/build-runtime.mjs) exports the upstream source and its nested dependencies, at their recorded commits, to its build directory, applies this repository's Darwin startup, TLS, filesystem and Vulkan adapters, and builds the x86-64 PRX libraries, leaving the upstream checkouts unchanged. The runtime requires macOS 26 or later because the upstream code uses the floating-point character conversion APIs in Apple libc++.

```sh
git submodule update --init --recursive sources/anyps5
node producers/anyps5/build-runtime.mjs --check
node producers/anyps5/build-runtime.mjs --jobs 4
```

The default output is `out/anyps5-runtime`. Besides every nested Git source, the [dependency file](../producers/anyps5/dependencies.json) lists a macOS FFmpeg binary, which the runtime build downloads and checks against its SHA-256. Build outputs and generated source projections stay outside the upstream checkout.

### Darwin host adapters

The host adapters use native macOS interfaces for:

- Mach virtual-memory and page-state queries
- process arguments and thread identifiers
- BSD error translation
- directory streams
- network interface and DNS configuration

Guest image metadata keeps its initialization, finalization and unwind information, and the upstream kernel startup, TLS allocation, main-thread dispatch and Darwin thread scheduling are used unchanged. Adapters for the image lifecycle preserve guest call state and run each finalizer once. A native TLS key stays allocated while a loaded image or a live thread allocation still uses it, and is released after the image finalizers and the last live thread allocation.

AnyPS5's Mach-O link-edit writer keeps its import and export logic; a small adapter only enlarges its tables, without changing their order relative to the file data that follows them.

Optional import-call tracing uses a native JIT mapping and preserves call arguments and return values. Host CPU-mask pinning and per-sensor hardware temperature readings report an explicit unsupported result.

### Window and input

SDL window, event and mouse-mode changes run on the Cocoa main thread. The macOS cursor starts visible and uncaptured. F7 captures or releases it, and a release made this way stays in effect when window focus changes.

Mouse input takes one of two routes: exclusively to the controller, or to the native mouse API. On the controller route, the configured button bindings apply even when a game opens the native mouse API. The runtime manifest declares the mouse routing and touchpad binding capabilities.

### Renderer optimizations

These renderer changes are general and independent of the Darwin host adapters:

- Graphics pipelines use dynamic blend constants, so a change to the constant values reuses the same static pipeline.
- Generated geometry and tessellation helper shaders use a size-limited cache keyed by shader contents, interpolation metadata and device limits.
- Rectangle preparation resolves the requested shader pair and keeps pairs that were prepared separately.
- Resource preparation reserves storage according to descriptor metadata.
- Shader validation results are cached per exact module contents, binding metadata, draw state and device capabilities.

## Package

The [package producer](../producers/anyps5/package-runtime.mjs) combines the two builds into a runtime archive. It records the actual CPU slices, marks the x86-64 libraries for Intel execution, adds the required license notices, makes library dependencies relative and signs the resulting Mach-O files.

```sh
node producers/anyps5/package-runtime.mjs \
  --runtime-build /absolute/path/to/anyps5-runtime \
  --relinker-build /absolute/path/to/anyps5-relinker \
  --output /absolute/path/to/package-output \
  --version <explicit-version> --arch x64
```

The payload contains `tools/relinker`, `tools/unwrap-self.cjs`, `libs/*.prx`, `source.json`, `runtime.json` and license notices. The archive and inventory use the shared [Builds package format](PACKAGES.md#package-tools).

The package contains no Vulkan library. Instead, `ANYPS5_VULKAN_LIBRARY` selects an x86-64-compatible library for both SDL and the renderer to load, and a MoltenVK or KosmicKrisp library used this way must contain the CPU slice of the game process.

### SELF extraction

The package's SELF helper, `tools/unwrap-self.cjs`, is a Node version of AnyPS5's [`tools/unwrap_self.py`](../sources/anyps5/tools/unwrap_self.py) with the same segment placement and validation. It extracts plain ELF files from decrypted SELF/fSELF containers and refuses inputs whose load segments appear encrypted, so encrypted retail executables are not supported.

## License

The upstream source and this repository's adapters are licensed GPL-2.0-only, with the license text in the upstream [`LICENSE`](../sources/anyps5/LICENSE). Dependencies keep their own licenses.

## GitHub build

The shared [Runtime build workflow](../.github/workflows/runtime-build.yml) runs [build-anyps5.mjs](../tools/build-anyps5.mjs). Its registry entry declares CMake, Ninja, pkg-config and the recursive AnyPS5 source checkout. Each job builds the relinker for the requested CPU and the same x86-64 runtime libraries, then produces the package declaration and payload used by the shared release command. ARM64 runs on the Apple Silicon runner; x64 runs on the Intel runner. The recipe downloads the FFmpeg dependency and a build-only CPython interpreter for the selected CPU recorded in `dependencies.json`, checking their sizes and SHA-256 values before extraction. Python runs from an isolated environment and generates glslang headers; the interpreter is excluded from the runtime payload.

```sh
node tools/init-runtime-sources.mjs --project anyps5 --version MCLv2-1027-2
node tools/build-runtime.mjs --project anyps5 --arch arm64 \
  --version MCLv2-1027-2 --work /absolute/path/to/new-work \
  --output /absolute/path/to/new-output
```

The ARM64 runner uses Xcode 27; the Intel runner uses Xcode 26.6 and SDK 26.5. Both use the declared Homebrew tools. Runtime packages require macOS 26 or later. [Verifying MacLauncher Builds](../VERIFYING.md) explains archive checks and rebuild comparisons.
