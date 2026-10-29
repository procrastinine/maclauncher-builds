# AnyPS5

[AnyPS5](https://github.com/boykopovar/AnyPS5) converts PS5 executables and bundled
modules to host executable formats. Its source is pinned under
[`sources/anyps5`](../sources/anyps5). The macOS package combines an ARM64
conversion tool with x86-64 Mach-O system libraries. Converted game code runs
through Rosetta on Apple Silicon.

Recipes keep the pinned upstream checkout pristine. The runtime's tracked Git
dependencies retain exact revisions and public origins in the dependency
metadata. Ordered source transformations apply to a disposable tracked-file
projection, with checks at the source boundaries they adapt. Resynchronizing the
projection removes obsolete files while preserving unchanged file timestamps.
Compiler outputs remain in a separate build directory.

## Conversion tool

The [`relinker recipe`](../producers/anyps5/source.json) builds the conversion
tool with CMake and an Apple C++20 toolchain. Both recipes share the pinned
[source projection](../producers/anyps5/source-projection.mjs); the conversion
tool applies the Darwin image metadata adapter in its owned projection.

```sh
git submodule update --init sources/anyps5
node producers/anyps5/build-relinker.mjs --check
node producers/anyps5/build-relinker.mjs --jobs 4
```

The default build directory is `out/anyps5-relinker`. `--build-dir` selects an
absolute output directory outside the upstream checkout. The projection is
written to its `source` subdirectory and the executable remains at
`core/relinker/relinker`. A build directory configured against a different source
root requires a separate output directory. `--check` verifies the source pin and
public origin without creating build outputs. The build invokes the
relinker with `--help` after compilation. Third-party submodules are unnecessary
for this relinker-only recipe.

The ARM64 tool produces x86-64 game executables, including Mach-O output with
`--macos`. `--to-rosetta` applies supported x86 instruction substitutions.
Converted games require the matching host system-library implementations.
The upstream relinker-only target builds the converter without those libraries.
The macOS runtime recipe supplies the libraries separately.

## macOS runtime

The [`runtime recipe`](../producers/anyps5/build-runtime.mjs) exports the exact
upstream and nested dependency pins to its build directory, applies the owned
Darwin startup, TLS, filesystem and Vulkan adapters, and builds x86-64 PRX
libraries. The runtime requires macOS 26 or later for the upstream floating-point character conversion APIs in Apple libc++. Upstream checkouts remain unchanged.

```sh
git submodule update --init --recursive sources/anyps5
node producers/anyps5/build-runtime.mjs --check
node producers/anyps5/build-runtime.mjs --jobs 6
```

The default output is `out/anyps5-runtime`. The
[`dependency metadata`](../producers/anyps5/dependencies.json) identifies every
nested Git source and the macOS FFmpeg binary input. The runtime build downloads
the matching FFmpeg package and verifies its SHA-256. Build outputs and generated
source projections remain outside the upstream checkout.

Darwin host adapters use native Mach virtual-memory and page-state queries,
process arguments and thread identifiers, BSD error translation, directory
streams, and native network interface and DNS configuration. Guest image metadata
preserves initialization, finalization and unwind information. Upstream kernel
startup, TLS allocation, main-thread dispatch and Darwin thread scheduling remain
in use. Owned lifecycle adapters preserve guest call state, run finalizers once
and retain TLS keys while loaded images or live thread allocations still use them. The upstream Mach-O link-edit writer retains
its import and export logic; a narrow adapter grows its tables without changing
their order relative to following file data. Native TLS keys
retire after image finalizers and the last live thread allocation. Optional
import-call tracing uses a native JIT mapping and preserves call arguments and
return values. Host CPU-mask pinning and per-sensor hardware temperature readings
retain explicit unsupported results.

SDL window, event and mouse-mode changes run on the Cocoa main thread. The
macOS cursor starts visible and uncaptured; F7 selects capture or release.
Explicit release remains in effect across window focus changes. Mouse input can
use exclusive controller or native mouse routes. Controller routing applies
configured button bindings even when a game opens the native mouse API. The
runtime manifest declares mouse routing and touchpad binding capabilities.

General renderer optimizations are separate from the Darwin host adapters.
Graphics pipelines use dynamic blend constants so changing their values reuses
the same static pipeline. Generated geometry and tessellation helper shaders use
a bounded cache keyed by shader contents, interpolation metadata and device
limits. Rectangle preparation resolves the requested shader pair and retains
independently prepared pairs. Resource preparation reserves storage from descriptor
metadata. Shader validation caches exact module contents, binding metadata, draw
state and device capabilities.

The [`package producer`](../producers/anyps5/package-runtime.mjs) combines the
two builds into a managed runtime archive. It records actual CPU slices, marks
x86-64 libraries for Intel execution, supplies required license notices, makes
library dependencies relative and signs the resulting Mach-O files.

```sh
node producers/anyps5/package-runtime.mjs \
  --runtime-build /absolute/path/to/anyps5-runtime \
  --relinker-build /absolute/path/to/anyps5-relinker \
  --output /absolute/path/to/package-output \
  --version <explicit-version>
```

The payload contains `tools/relinker`, `tools/unwrap-self.cjs`, `libs/*.prx`,
`source.json`, `runtime.json` and license notices. The archive and inventory use
the shared Builds package format. Vulkan libraries are managed separately;
`ANYPS5_VULKAN_LIBRARY` selects the x86-64-compatible library for both SDL and the
renderer. MoltenVK and KosmicKrisp libraries must contain the CPU slice used by
the game process.

The Node SELF helper preserves the segment placement and validation behavior of
AnyPS5's [`tools/unwrap_self.py`](../sources/anyps5/tools/unwrap_self.py). It
extracts plain ELF files from decrypted SELF/fSELF containers and refuses inputs
whose load segments appear encrypted. Encrypted retail executables are not
supported. Game inputs, assets and saves remain separate from runtime packages.

The pinned upstream source and owned adapters use GPL-2.0-only. The upstream
[`LICENSE`](../sources/anyps5/LICENSE) supplies the license text. Dependencies
retain their accompanying licenses.
