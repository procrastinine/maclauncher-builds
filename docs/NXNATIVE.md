# nxnative native tools

[nxnative](https://github.com/seedds/nxnative) is the runtime that MacLauncher uses for Nintendo Switch games. The `nxnative-tools` package built in this repository holds its native parts: an ARM64 native host, a package extractor, shader translator and compiler tools, Python dependencies at fixed versions, a .NET runtime and the launcher adapters. It requires Apple Silicon and macOS 26 or later, and it contains no Python interpreter or standard library, because MacLauncher provides a compatible CPython in a private environment. MacLauncher's [Nintendo Switch](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/SWITCH.md) page describes how games use the runtime.

## Upstream source

The upstream nxnative scripts, game profiles and source data are not part of this package. MacLauncher downloads the selected upstream commit separately, or uses a local source directory instead, and the source is passed to the tools as described under [Preparation](#preparation). Each native-tools version records the commit and commit date of the source it was built from, independently of the scripts that MacLauncher selects.

Earlier self-contained packages, which included source snapshots, were published under the project ID `nxnative`; the current producer publishes only `nxnative-tools`.

## Preparation

When a game is first played, the tools prepare it from its NSP, XCI, NSZ or XCZ application container. Encrypted content needs a local keys file, which is selected separately, and rewritten modules, shader data, generated fonts, logs and saves go in a separate working directory for each application.

MacLauncher passes the selected interpreter and source to the tools in environment variables:

| Variable | Value |
| --- | --- |
| `NXNATIVE_PYTHON` | Resolved isolated Python interpreter |
| `NXNATIVE_SOURCE_ROOT` | Selected source directory |
| `NXNATIVE_SOURCE_REVISION` | Selected source revision |
| `NXNATIVE_SOURCE_COMMITTED_AT` | Commit date of the selected source (optional) |

A downloaded source is identified by its exact upstream commit, and a local source directory by its path and content rather than a Git commit. Inspecting program metadata alone does not need a source.

The package's command adapter checks the layout of the selected source and then uses its scripts. It does not check the source's files again, because MacLauncher verifies a downloaded source when it installs it. The adapter copies the source into a writable workspace keyed by the tools version and the source, so the selected source tree is not modified.

### Shader chain

The native host accepts its own compiled shader-chain format. Before extraction, preparation computes the selected source's shader chain with the fingerprints of the package's tools and rejects an incompatible format. The workspace contains the production inputs that the selected shader-chain tool declares, including the vendored translator lowering sources. The adapter passes the path of the package's SPIRV-Cross explicitly and accepts the upstream toolchain callback arguments.

Compatibility is therefore decided by the actual interfaces and the format version, not by a list of allowed source commits, and a source change that requires a different native format needs native tools that support that format.

The package keeps only the compiled shader translator, with the libraries it needs, and the generated toolchain metadata. The Python tools, profiles and tables come from the upstream source. The upstream font tool generates the Nintendo button fonts from system fonts.

### Metal compilation

A Metal compiler call without an optimization override keeps its output as explicit MSL source objects, which the native loader compiles through the system Metal API. A call that requests `-O1` runs the Apple Metal compiler with the original arguments, including `-fpreserve-invariance`, and produces native AIR and metallib files. Native AIR and source objects cannot be linked together.

The package declares that it needs Apple's Metal toolchain, which is checked before preparation. Apple's compiler files are downloaded separately from Apple and are not part of this package; MacLauncher passes the root of the verified `Metal.xctoolchain` in `MCL_APPLE_METAL_TOOLCHAIN_ROOT`. The adapter keeps the caller's explicit compiler options and SDK selection; when the caller names no SDK, it uses the declared target SDK version. The routes through the system compiler and through source objects remain available.

## Producer

This repository includes the native source as the submodule `sources/nxnative`, fixed at an exact commit, and keeps its own recipes and platform adapters in `producers/nxnative`, where `source.json`, `dependencies.json` and `nx-extract.lock.json` select the native inputs. The recipes never modify the submodule checkout, and its source is not included in the runtime release.

Building requires Node 24 or later, the .NET SDK and the macOS SDK declared in `source.json`. Output archives use the standard [package format](PACKAGES.md#package-tools), under the project `nxnative-tools`.

| Script | Purpose |
| --- | --- |
| `build.mjs` | Creates the full build output, built with Python binaries at fixed versions |
| `package.mjs` | Selects the native runtime files, without the build's Python interpreter or the upstream source tree |
| `refresh-runtime.mjs` | Reuses a verified, compatible native output for adapter changes |

A refresh requires unchanged native inputs and a new version, and leaves earlier packages unchanged.

## GitHub build

The shared [Runtime build workflow](../.github/workflows/runtime-build.yml) uses [build-nxnative.mjs](../tools/build-nxnative.mjs) for the ARM64 tools package. Its registry entry selects the upstream source and the exact SPIRV-Cross, glslang and Zstandard sources. CMake and Ninja are declared Homebrew build tools. The recipe downloads .NET SDK 10.0.401 into its own work directory, checks its SHA-256 and requires macOS SDK 27.0. The [SDK declaration](../producers/nxnative/dotnet-sdk.json) also records Microsoft's SHA-512.

```sh
node tools/init-runtime-sources.mjs --project nxnative-tools --version MCLv2-1027-3
node tools/build-runtime.mjs --project nxnative-tools --arch arm64 \
  --version MCLv2-1027-3 --work /absolute/path/to/new-work \
  --output /absolute/path/to/new-output
```

The output contains the package declaration and runtime payload. Downloaded build SDKs, the Python interpreter used to prepare the package and upstream source stay outside that payload. [Verifying MacLauncher Builds](../VERIFYING.md) describes archive checks and rebuild comparisons.
