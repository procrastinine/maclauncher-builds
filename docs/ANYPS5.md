# AnyPS5

[AnyPS5](https://github.com/boykopovar/AnyPS5) converts PS5 executables and their bundled modules into executable formats of the host system. The macOS package has a conversion tool called the relinker for its selected CPU, and x86-64 Mach-O system libraries for the converted games. The games run natively on Intel Macs and through Rosetta on Apple Silicon. MacLauncher's [PlayStation 5](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/PS5.md) page describes how games use the runtime.

The AnyPS5 source is the submodule [`sources/anyps5`](../sources/anyps5), fixed at an exact commit, and the build recipes never modify that checkout. `producers/anyps5/dependencies.json` records the exact commit and public repository URL of every Git dependency the runtime uses.

Each build copies the tracked files into a disposable working copy, called the source projection, and applies this repository's changes to it in a fixed order; each change first checks that the upstream code it adapts still matches. When a projection is synchronized again, files that no longer exist are removed and unchanged files keep their timestamps. Compiler output goes to a separate build directory.

## Conversion tool

The [relinker recipe](../producers/anyps5/source.json) builds the conversion tool with CMake and an Apple C++20 toolchain. It shares the [projection script](../producers/anyps5/source-projection.mjs) with the runtime recipe described below. Its adapters preserve Darwin image metadata, allow guest protection changes on generated image segments, register padding segments and order guest module initialization after resolved import providers. Placeholder libraries whose exported functions are all zero-return stubs defer to the host implementation; functional guest libraries retain their exports and two-level import ordinals.

```sh
git submodule update --init sources/anyps5
node producers/anyps5/build-relinker.mjs --check
node producers/anyps5/build-relinker.mjs --jobs 4
```

The default build directory is `out/anyps5-relinker`. `--arch arm64` or `--arch x64` selects the conversion tool's CPU; the default is the build host's CPU. `--build-dir` selects another absolute output directory, which must be outside the upstream checkout. The projection is written to the build directory's `source` subdirectory, and the executable is built at `core/relinker/relinker`. A build directory configured against a different source root cannot be reused, so that build needs its own output directory.

`--check` verifies the checkout's commit and repository URL without creating build outputs. A full build ends by running the relinker with `--help`, and it does not need the third-party submodules.

Both tool builds produce x86-64 game executables: `--macos` selects Mach-O output, and `--to-rosetta` applies the supported x86 instruction substitutions. A converted game also needs host implementations of the system libraries, which the upstream relinker-only target leaves out and the macOS runtime recipe provides.

## macOS runtime

The [runtime recipe](../producers/anyps5/build-runtime.mjs) exports the upstream source and its nested dependencies, at their recorded commits, to its build directory, applies this repository's Darwin startup, TLS, filesystem and Vulkan adapters, and builds the x86-64 PRX libraries, leaving the upstream checkouts unchanged. Darwin startup retains the initial stack mapping for native launch data while execution moves to separate host and guest stacks. The runtime requires macOS 26 or later because the upstream code uses the floating-point character conversion APIs in Apple libc++.

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

Guest image metadata keeps its initialization, finalization and unwind information. Darwin adapters cover kernel startup, TLS allocation, main-thread dispatch and thread scheduling. Adapters for the image lifecycle preserve guest call state and run each finalizer once. A native TLS key stays allocated while a loaded image or a live thread allocation still uses it, and is released after the image finalizers and the last live thread allocation.

AnyPS5's Mach-O link-edit writer keeps its import and export logic; a small adapter only enlarges its tables, without changing their order relative to the file data that follows them.

Optional import-call tracing uses a native JIT mapping and preserves call arguments and return values. Host CPU-mask pinning and per-sensor hardware temperature readings report an explicit unsupported result.

Kernel file reads flush pending GPU writes under the GPU memory mutex before writing guest memory. Unwatched storage-image results are written back when their saved guest state permits it. Pending storage-image results are dropped when their memory is no longer registered. Re-registration under a new allocation drops only the affected units; other selected units retain their results. Protection changes and backing renewal within the same allocation preserve pending results. Write-watch registrations reset contained ranges in place, sequential faults share the existing protection block, and allocation and coverage snapshots retain their owners during concurrent reads.

A SIGSEGV or SIGBUS that write-watch does not handle is reported on standard error before the guest handler chain or the default action runs. The report gives the signal, the fault address, the faulting thread's frames, the x86-64 program counter, stack pointer and frame pointer, and the loaded image list, and is written with write(2) only. A repeating fault is reported for its first four occurrences. Standard output is line-buffered when it is not a terminal.

File and device event filters support low-water marks, Sysmodule unwind queries use kernel image metadata, and socket information accepts kernel socket descriptors. JIT memory uses shared Mach mappings. USB event handling preserves waiter ownership. Thread CPU clocks use Mach thread accounting, and spatial audio applies listener transforms, distance and cone attenuation, and Doppler adjustment.

Recorder/submission workers, the draw committer and the presentation thread request Darwin user-interactive QoS through the shared thread-priority helper at thread start, independently of the optional upstream thread-priority setting. This scheduling request leaves core placement to macOS. A refused request is logged.

### Add-ons and updates

`ANYPS5_ADDCONT_DIRS` supplies colon-separated add-on directories. Enumeration, entitlement status and mounts follow the content actually present in those directories. `ANYPS5_UPDATE_DIR` supplies an update directory whose non-module files override matching base-game files; a missing update file falls back to the base path. Updated executables and modules require conversion into the prepared game directory before launch.

### Window and input

SDL window, event and mouse-mode changes run on the Cocoa main thread. The macOS cursor starts visible and uncaptured. F7 captures or releases it, and a release made this way stays in effect when window focus changes.

Mouse input takes one of two routes: exclusively to the controller, or to the native mouse API. On the controller route, the configured button bindings apply even when a game opens the native mouse API. The runtime manifest declares the mouse routing and touchpad binding capabilities.

Four controller slots keep separate input and motion state. Standard extended-pad reads use the standard controller records; invalid or unavailable controller ports return the corresponding controller error.

### Renderer optimizations

These renderer changes are general and independent of the Darwin host adapters:

- Graphics pipelines use dynamic blend constants, so a change to the constant values reuses the same static pipeline.
- Generated geometry and tessellation helper shaders use a size-limited cache keyed by shader contents, interpolation metadata and device limits.
- Rectangle preparation resolves the requested shader pair and keeps pairs that were prepared separately.
- Resource preparation reserves storage according to descriptor metadata.
- Shader validation results are cached per exact module contents, binding metadata, draw state and device capabilities.
- Copied shader headers use safe guest-memory reads. Null vertex descriptors and indices beyond every applicable vertex record fetch zeros without allocating padding up to the original index.
- Buffer pools retain allocation capacity for explicitly ranged resources, adjacent host imports support GPU copies, and unchanged descriptor bindings reuse their allocations.
- Command-buffer flips admit one next submission while waiting for the preceding GPU epoch. The wait retains its originating device and reaps completion labels and write-backs before returning. CPU flips, title-progress escapes and devices without timelines retain their existing ordering. `APS5_NO_FLIP_OVERLAP=1` keeps the GPU wait before admission.
- Draws with a single-sample depth target do not drain the draw pipeline for DB_RENDER_CONTROL clear or expand bits, because only native multisample depth surfaces record the render control.
- Address-based shader reads and writes keep a per-invocation record of the last page-table range each lookup kind found: read lookups and span reads share one record, write lookups another and atomic lookups a third. An access inside that range is translated without the table checks and the search; any other access performs the full lookup. The written-page note skips its table atomics when the same invocation already noted the same page.

### Queue completion and diagnostics

- A completion counted outside a queue worker, such as a CPU write-back over a GPU-stored completion label or a deferred end-of-pipe interrupt added by another queue, wakes the first graphics queue's idle worker. While recorded command batches exist, that worker's idle wait lasts at most 2 ms. `APS5_NO_BOUNDED_IDLE_WAIT=1` restores the untimed idle wait.
- When the first graphics queue takes no submission and stays on the same packet for 5 seconds while completions, deferred interrupts, recorded work or command batches are pending, one `[watchdog]` line reports the worker's wait state and consecutive failed idle lock attempts, the GPU mutex holder with its thread, lock site and calling code address, the pending completion counts and the last packet of every queue. The line repeats only after that queue moves again. `APS5_QUEUE_WATCHDOG_MS` sets the interval in milliseconds; `0` turns the report off.
- Under `APS5_PROFILE_DRAW` or a performance trace, a command batch whose timestamps were not yet available when it finished keeps its timestamp pool until the presentation that waited for it retires. The `[present]` line's and the trace summary's GPU busy time include such batches, and the `[present]` line counts them as timed at the retire.

### Renderer compatibility

Capabilities select the rendering route. Storage images use sample zero when storage-image multisampling is unavailable, while sampled multisample images retain their native representation. Degenerate rectangles are culled. Tessellation-evaluation stages without subgroup support use single-lane lowering. Devices without last-vertex provoking reorder observable direct primitives while preserving winding and primitive restart.

On macOS, geometry-path draws on devices without mesh shaders can use a compute pass followed by a vertex draw when push descriptors are available. This fallback supports triangle output with position, parameter and layer records. Clip and cull distances, custom interpolation and mesh barycentric outputs retain the unsupported-work result. Devices with mesh shaders keep their existing mesh route, and other graphics draws retain their existing paths.

Unbindable draws and dispatches are skipped independently, with each reason logged once. Shader loop continue blocks retain their phi values through SPIR-V translation, image atomics preserve store ordering, and subgroup results use explicit storage across Metal expression lowering. Sampler LOD bias follows the device limit.

## Package

The [package producer](../producers/anyps5/package-runtime.mjs) combines the two builds into a runtime archive. It records the actual CPU slices, marks the x86-64 libraries for Intel execution, includes available licence texts, makes library dependencies relative and signs the resulting Mach-O files.

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

The upstream source and this repository's adapters are licensed GPL-2.0-only, with the license text in the upstream [`LICENSE`](../sources/anyps5/LICENSE). Portions of the overlays are adapted from [AnyPS5-ARM](https://github.com/AnyTogether/AnyPS5-ARM). The [source record](../producers/anyps5/source.json) identifies its exact source snapshot and GPL-2.0-only license; the derived overlay files identify the source commits for their adapted portions. Packages retain this attribution in `source.json` and the license component index. Dependencies keep their own licenses.

## GitHub build

The shared [Runtime build workflow](../.github/workflows/runtime-build.yml) runs [build-anyps5.mjs](../tools/build-anyps5.mjs). Its registry entry declares CMake, Ninja, pkg-config and the recursive AnyPS5 source checkout. Each job builds the relinker for the requested CPU and the same x86-64 runtime libraries, then produces the package declaration and payload used by the shared release command. ARM64 runs on the Apple Silicon runner; x64 runs on the Intel runner. The recipe downloads the FFmpeg dependency and a build-only CPython interpreter for the selected CPU recorded in `dependencies.json`, checking their sizes and SHA-256 values before extraction. Python runs from an isolated environment and generates glslang headers; the interpreter is excluded from the runtime payload.

```sh
node tools/init-runtime-sources.mjs --project anyps5 --version MCLv2-1027-2
node tools/build-runtime.mjs --project anyps5 --arch arm64 \
  --version MCLv2-1027-2 --work /absolute/path/to/new-work \
  --output /absolute/path/to/new-output
```

The ARM64 runner uses Xcode 27; the Intel runner uses Xcode 26.6 and SDK 26.5. Both use the declared Homebrew tools. Runtime packages require macOS 26 or later. [Verifying MacLauncher Builds](../VERIFYING.md) explains archive checks and rebuild comparisons.
