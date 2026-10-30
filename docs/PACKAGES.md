# Runtime packages

This page describes how MacLauncher Builds is organized: its project registries, the producers that build each project, its package format and the tools that create and check packages. Commands and paths are relative to a checkout of this repository. The package tools run with Node.js 24 or later and do not need MacLauncher itself.

Each project is built by a producer: the scripts and recipes that turn the project's upstream source, MacLauncher's changes to it and any other inputs into a finished runtime directory. A producer's files are in the directory named by the `sourceDirectory` field of its project's record, most often `producers/maclauncher/`; some projects have their own directory under `producers/`. The Android runtime has its own source project, `maclauncher-android`, included as the submodule `sources/maclauncher-android`. A prebuilt project, such as the Flash projector, builds nothing; its package contains a binary supplied by the publisher. The package tools then turn a finished runtime directory into a release archive, and compiled packages are not committed to Git. A project can also have a GitHub build command, which compiles the project on GitHub-hosted Macs with one job per architecture; the [release reference](RELEASES.md#github-builds) describes that workflow.

MacLauncher's [runtime distribution](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIME_DISTRIBUTION.md) reference describes how the app installs these packages.

## Producer pages

Some producers have their own reference page:

- [AnyPS5](ANYPS5.md): the PS5 executable converter and the x86-64 macOS system libraries that converted games run with.
- [mpv decoded-frame runtime](MPV.md): the native libmpv host that passes decoded video frames to MacLauncher's graphics presenter.
- [nxnative native tools](NXNATIVE.md): the native host, package extractor and shader tools for nxnative.

[Upstream commit references](SOURCE_PINS.md) describes how a project record points to the file in which its producer records the exact upstream commit.

## Projects and packages

[projects.json](../projects.json) names two project registries: [downloadable runtimes and tools](../projects/downloadable.json) and [bundled components](../projects/bundled.json). Each project is in exactly one of them, and the registry sets the project's `delivery` value, `downloadable` or `bundled`. MacLauncher installs downloadable packages separately from the app, while bundled packages are built into the app. A project record names the producer, the upstream repositories with a reference to the exact commit of each, and the producer's entry files; a project built on GitHub also has a `build` record with its build command and architectures, or an array of records for distinct ABI versions. `readProjects()` reads both registries into one validated list. The [package index](https://procrastinine.github.io/maclauncher-builds/) shows the two groups separately, and its JSON records include each project's `delivery` value.

Native builds share `producers/maclauncher/scripts/native-binary-tools.cjs` for Mach-O inspection, dependency copying and license notices, without loading MacLauncher's module registry. That script and a few other build scripts are copies of MacLauncher files. `producers/maclauncher/native-tools-source.json` records the hash of each original and of each copy, and the import change that the standalone KosmicKrisp build needs. This command copies the files again from a MacLauncher checkout and checks those hashes:

```sh
node producers/maclauncher/refresh-native-tools.mjs --source /path/to/maclauncher
```

Portable native producers share `tools/seal-runtime.mjs`. After a producer compiles an executable, the sealer copies its non-system library dependencies, keeps the selected CPU slice, changes library references to paths inside the package, includes license notices and verifies signatures. The manifest records the measured macOS requirement of the complete library set. Original sources and build outputs remain unchanged.

[Per-project catalogs](../catalogs) record the published versions, CPU architectures and archive checksums, including the separate HashLink ABI packages. MacLauncher reads these records during Refresh. Later versions and CPU builds of a managed runtime appear without a launcher update when they retain its supported package format. The records describe the files; MacLauncher chooses the native default and applies macOS, hardware and Rosetta requirements.

### Package architectures

Every package is built for one architecture: `arm64` for Apple Silicon, `x64` for Intel, or `universal` with code for both, and its catalog record keeps the actual binary architecture and macOS requirement. MacLauncher installs packages for the architecture it runs as, which is `x64` for the Intel app even when it runs through Rosetta. A project compiled in this repository therefore gets separate `arm64` and `x64` packages wherever both kinds of Mac can run it, so that each download carries code for a single CPU. A GitHub build compiles the `x64` package on an Intel runner, so producing it needs no Mac with Rosetta. The `build` records of the GameMaker 8 decompiler, the AliceSoft System3 and System3.5 decompilers, RPGMakerDecrypter, the APK metadata tool, the CatSystem2 KIF cryptography helper and the browser network helper list both CPUs.

Other projects keep a different architecture for a fixed reason:

| Architecture | Reason | Projects |
| --- | --- | --- |
| `universal` | The native code is loaded into a game's process, and on Apple Silicon a game can run as either CPU type | Steam API helper, Steam ticket adapter, LuaSteam bridge, Steamworks4j 1.10, MKXP-Z configuration helper, GameMaker OpenGL helper, RLVM adapter, MacLauncher graphics |
| `universal` | No native code | VNDS-LOVE, Android launcher integrations |
| `universal` | The publisher's binary is universal | Flash projector |
| `arm64` | The package runs ARM64 Android, iOS or Switch code, or serves Android games, all of which need Apple Silicon | `android`, `android-art`, `android-aim`, `android-privacy`, `nxnative-tools`, `ios-playtools-paths` |
| `arm64` | The package requires macOS 27, which Intel Macs cannot install | `mpv`, `vulkan-kosmickrisp-gles32` |
| `x64` | HashLink 1.9 and 1.12 compile games to x86-64 code at run time, and the publisher's Steamworks4j 1.9 library is x86-64 only; on Apple Silicon these packages run through Rosetta | HashLink 1.9 and 1.12, Steamworks4j 1.9 |

MKXP-Z uses `arm64` for its adapted package: its package adds Apple Silicon filename normalization to the publisher's universal build, and Intel Macs use the publisher's build directly.

### Build SDK and runtime compatibility

The macOS SDK on a build host does not set a package's minimum macOS version. Graphics, for example, is compiled with SDK 27 for its Universal build and an earlier SDK for Intel, and its shared core targets macOS 13. The package manifest records the build SDK separately from `minimumMacOS`, and optional native files and providers keep their own macOS and hardware requirements. MacLauncher checks those requirements before it enables each component, so one package can contain code for newer features and still run on older systems.

The graphics `runtime.json` stores the build SDK in `build.sdkVersion`. A build that includes the macOS 27 MetalFX motion-vector and subregion inputs declares `features.graphics.metalFX27InputsAPI: 1`, with `features.graphics.requirements.metalFX27Inputs.minimumMacOS: "27.0"`. Native file inventories record the actual CPU slices, `optionalLoad` gives the architectures and macOS requirement of a library that only a selected feature loads, and provider descriptors keep their own requirements.

### Downloadable runtimes

| Project | Package ID | Build contents |
| --- | --- | --- |
| [MacLauncher Android](../sources/maclauncher-android) | `android` | Shared Android framework, JVM execution and native host adaptations |
| [MacLauncher Android ART adapter](../sources/maclauncher-android) | `android-art` | ART execution, compiled framework data, native services and image reader |
| [AIM](https://github.com/hahnlee/aim) | `android-aim` | Private storage, display routing and process integration |
| [AI5 SDL2](https://github.com/nunuhara/ai5-sdl2) | `ai5` | Disc/archive access, save paths and font routing |
| [AnyPS5](https://github.com/boykopovar/AnyPS5) | `anyps5` | ARM64 converter for PS5 executables and the x86-64 macOS system libraries for converted games |
| [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) | `butterscotch` | Native AppKit runner and game arguments |
| [FNA](https://github.com/FNA-XNA/FNA) | `fna` | Managed game host, XNA facades and native graphics integration |
| [GemRB](https://github.com/gemrb/gemrb) | `gemrb` | Native command-line entry and scripting-symbol linkage |
| [HashLink](https://github.com/HaxeFoundation/hashlink) | `hashlink` | Legacy 1.9 and 1.12 VM/native-module ABI profiles |
| [impacto](https://github.com/CommitteeOfZero/impacto) | `impacto` | Windows scripts, input, audio, saves and backlog adaptations |
| [Kirikiri SDL2](https://github.com/krkrsdl2/krkrsdl2) | `krkrsdl2` | Storage access, fonts and full-frame presentation |
| [MKXP-Z](https://github.com/mkxp-z/mkxp-z) | `mkxpz` | macOS filename normalization for Apple Silicon |
| [mpv decoded-frame host](MPV.md) | `mpv` | GPU video frames, audio timing and shared presentation |
| [libnpengine](https://github.com/FGRE/libnpengine) | `npengine` | Script compiler, choice handling and native media runner |
| [nxnative native tools](NXNATIVE.md) | `nxnative-tools` | ARM64 native host, package extraction, shader tools and launcher adapters; the upstream nxnative scripts are not included |
| [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN) | `onscripter-en` | Native Cocoa shell and portable SDL/media libraries |
| [ONScripterYuri](https://github.com/YuriSizuku/OnscripterYuri) | `onsyuri` | Empty-page state reset and portable native libraries |
| [OpenGMK](https://github.com/OpenGMK/OpenGMK) | `opengmk` | Native AppKit, graphics, audio and extensions |
| [Prosper](https://github.com/mattias800/prosper) | `prosper` | Build recipe for an x86-64 macOS PS5 runtime, for local use only |
| [ReMinori](https://github.com/luoyily/ReMinori) | `reminori` | Fonts, movies, menus, saves and PAZ/PE profiles |
| MacLauncher RLVM adapter | `rlvm-adapter` | Cocoa integration library for the unmodified upstream RLVM app |
| [siglus_rs](https://github.com/xmoezzz/siglus_rs) | `siglus` | The publisher's siglus_rs library with a universal host program that calls its C API |
| [System3 SDL2](https://github.com/kichikuou/system3-sdl2) | `system3` | Executable-relative resources and native libraries |
| [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) | `vnds-love` | VNDS interpreter compiled from MoonScript to Lua, with wrappers for MacLauncher's LÖVE runtime |
| [xsystem35 SDL2](https://github.com/kichikuou/xsystem35-sdl2) | `xsystem35` | Executable-relative fonts/resources and native libraries |
| [xsystem4](https://github.com/nunuhara/xsystem4) | `xsystem4` | macOS OpenGL/shader support and resource paths |

The MKXP-Z package adds Unicode filename normalization for Apple Silicon at MKXP-Z's own file-system calls, and keeps the publisher's universal build as its baseline. Its producer is `producers/maclauncher/scripts/build-mkxpz-nfc.cjs`, the patch is recorded in `producers/maclauncher/src/modules/rgss/overlays/mkxpz-filename-nfc/source.json`, and `runtimes/mkxpz/baseline.json` identifies the publisher's build. The publisher's own releases are not repeated in the Builds catalog.

The upstream Prosper source has no license grant, so its recipe is marked for local use only and no Prosper package is published.

### Game and extraction tools

RPGMakerDecrypter builds from its exact upstream source commit with separate `osx-arm64` and `osx-x64` .NET SDK and runtime packages. Each SDK and NuGet archive has a checksum pin, and restoration uses the selected CPU’s dependency locks. The self-contained CLI includes its runtime; installing a separate .NET SDK is unnecessary.

| Project | Package ID | Build contents |
| --- | --- | --- |
| [OpenGMK GameMaker 8 decompiler](https://github.com/OpenGMK/OpenGMK) | `gm8-decompiler` | Native macOS build of the original decompiler |
| [innoextract](https://github.com/dscharrer/innoextract) | `innoextract` | JSON installer inspection tool and parser size limits |
| [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter) | `rpgmaker-decrypter` | ARM64 macOS build of the unmodified command-line tool for RPG Maker archive and asset extraction |
| [sys3c](https://github.com/kichikuou/sys3c) | `sys3-decompiler` | Native macOS build of the original decompiler |
| [xsys35c](https://github.com/kichikuou/xsys35c) | `xsys35-decompiler` | Native macOS build of the original decompiler |

### Downloadable graphics components

| Project | Package ID | Build contents |
| --- | --- | --- |
| [KosmicKrisp](https://gitlab.freedesktop.org/mesa/mesa) geometry/transform-feedback adaptation | `vulkan-kosmickrisp-gles32` | MacLauncher geometry-shader and transform-feedback implementation |
| [MoltenVK](https://github.com/KhronosGroup/MoltenVK) scene recording adaptation | `vulkan-moltenvk-scene` | MoltenVK 1.4.2 that records scene operations on the original Metal command buffer |
| WineVulkan scene adapter | `winevulkan-scene` | Scene recording in the Wine Vulkan layer of CrossOver 26.3, forwarding to the original native and WOW64 code |
| [FidelityFX](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) API adapter | `fidelityfx-api` | Proxy for the FidelityFX API DLL that keeps the original exports and behavior and adds a native Vulkan scene producer |
| GameMaker OpenGL helper | `gamemaker-opengl-helper` | Software OpenGL integration for selected official GameMaker runners |

The KosmicKrisp package contains only the adapted driver; the unmodified driver comes from its upstream binary release. Scene data is the renderer's own per-frame data, such as depth and motion vectors, that temporal upscaling and frame generation use. MacLauncher's [graphics inputs](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/INPUTS_AND_ADAPTERS.md#scene-producers) reference describes how the app uses it.

### Prebuilt runtimes

| Project | Package ID | Artifact |
| --- | --- | --- |
| Adobe Flash Player projector | `flash-projector` | Supplied 35.0.0.60 app, universal ARM64 and Intel |

The Flash projector package keeps the supplied universal binary, app bundle and notices unchanged.

### Included components

These components are built into the MacLauncher app, and the app build takes their versioned archives as input.

| Project | Package ID | Build contents |
| --- | --- | --- |
| MacLauncher graphics | `reshade` | Shared Metal/OpenGL/Quartz presentation and FX, Slang and MPV shader processing |
| Android APK metadata reader | `android-apk-metadata` | Local APK package and manifest inspection |
| [Android launcher integrations](../producers/android-launcher/README.md) | `android-launcher` | Java adapters for launch arguments, text input, account control and the Mac.apk policy, and Android JavaScript interfaces |
| Android privacy helper | `android-privacy` | Process-scoped clipboard broker |
| CatSystem2 KIF cryptography helper | `catsystem2-kif-crypto` | CommonCrypto KIF block adapter |
| Browser network helper | `web-renderer-network` | Node-API network policy for browser game renderers |
| PlayTools storage adapter | `ios-playtools-paths` | Private paths and device identity |
| [LuaSteam](https://github.com/uspgamedev/luasteam) LÖVE bridge | `love-luasteam` | Version 4 binding against the selected host Lua VM |
| MKXP-Z configuration helper | `mkxpz-config-helper` | Per-game configuration-path adapter |
| Steam API compatibility helper | `steam-api-helper` | Local offline ABI and storage implementation |
| Steam ticket availability adapter | `steam-ticket-loader` | Reject-only encrypted-ticket loader ABI |
| Java Steamworks compatibility libraries | `java-steamworks` | Steamworks4j 1.9 and 1.10 JNI ABI profiles |

The MKXP-Z configuration helper is MacLauncher integration code; the MKXP-Z runtime is the separate downloadable package.

`tools/build-helper.mjs` is the GitHub build command for MacLauncher's own helpers that compile from a few C, C++ or Objective-C files: the CatSystem2 KIF cryptography helper, the browser network helper, the Steam API and ticket helpers, the MKXP-Z configuration helper and the Android clipboard helper. Each has a build profile at `producers/maclauncher/helper-builds/<project>.json` that names its version, sources, compiler, output kind (executable, dynamic library or loadable bundle), flags, frameworks, minimum macOS, license and the fixed fields of its `helper.json` record. The command compiles the package for each CPU separately, joins the results for a universal package, signs the result ad hoc and writes `helper.json` with the source and binary checksums, the CPU slices and the compiler, SDK and flags of the build.

#### Graphics component

The MacLauncher graphics component (`reshade`) has its own [build recipe](../producers/maclauncher/scripts/graphics-runtime.json), which lists the CMake targets of its shared graphics processor, its upstream sources, prebuilt binary inputs and the builds of individual effect providers such as FSR, XeSS and libplacebo. The upstream sources are the submodules under `producers/maclauncher/src/external`. This command reports missing sources, inputs and tools without building anything:

```sh
node producers/maclauncher/scripts/build-graphics-runtime.mjs --check --work /absolute/work
```

`--fetch` downloads the inputs that have a recorded URL and checksum, and `--input id=path` supplies any other declared input. Every recorded checksum is verified. Without `--check`, the command builds the processor and its providers in the work directory, and `--stage` then places the finished component in the producer directory.

## Project and version identities

Each project has its own catalog at `catalogs/<project-id>.json`. A catalog (schema 2) names its project and contains only that project's packages. The project, version and CPU architecture determine the release tag, the archive name and the catalog file:

| Field | Example |
| --- | --- |
| Project | `android` |
| Version | `0.1.0` |
| Architecture | `arm64` |
| Release tag | `android/v0.1.0/arm64` |
| Archive | `android-0.1.0-arm64.tar.gz` |
| Catalog | `catalogs/android.json` |

A record includes the archive size and checksum, the checksums of the manifest and the source, the MacLauncher architectures the package supports and the minimum macOS version. Download URLs must match the registered release repository, project, tag and archive file name. Catalog generation rejects catalogs that mix projects or repeat a version and architecture pair.

A published package never changes: different archive bytes, a changed manifest or a changed release asset need a new package version. A record can later gain verified source information and capability fields without a new package, but existing fields cannot be removed or replaced.

Packages of tagged upstream releases use versions such as `1.2.3-MCLv1`, and the revision restarts at 1 for each new upstream version. Commit snapshots use `MCLv1-MMDD`, and their revision increases with every upstream or adaptation change. The [release reference](RELEASES.md#versions) defines these rules and describes how to change the version of an existing package.

Downloadable records give the upstream repository and commit in `source: {repository, revision, path?}`, matching the package's manifest, and the package's game and runtime requirements in a `capabilities` object of limited shape and size. `launcherContract` is a positive integer; a record without it uses contract 1. Records of bundled components identify exactly the package that MacLauncher selected.

## Android producer

The recipe for the `android` project builds from `sources/maclauncher-android`, a submodule fixed at an exact commit. A build needs that checkout without local changes, and explicit paths to the build inputs.

```sh
git submodule update --init sources/maclauncher-android
node tools/build-runtime.mjs --project android --check
node tools/build-runtime.mjs --project android --inputs /absolute/path/to/build-inputs.json
node tools/build-runtime.mjs --project android-art --check
node tools/build-runtime.mjs --project android-art --inputs /absolute/path/to/art-inputs.json
```

`tools/build-runtime.mjs` runs the producer registered for the selected project and never substitutes another project's producer. For a project whose producer has no single build entry, `--check` lists the producer's entry files, which are run directly. A prebuilt project has nothing to build and keeps its supplied binary.

### ART adapter

The `android-art` command uses the same Android checkout and its ART producer entries. Its input file contains the options of the source project's `buildArt` function, a `sources` object with absolute `source`, `klepton` and `glesHeaders` paths, and optional `runner` build options. The Android source project's `tools/build-art.mjs` producer returns the root of the built ART runtime and its matching `sourceArchive`.

Without an explicit archive, `sources.aosp` supplies the original AOSP source subsets selected by AIM's ART source lock, and `sourceCheckouts` supplies the checkouts of other registered components. The source exporter reuses the normal HWUI and native bridge source inputs; `hwuiSources` and `nativeBridgeSources` select the original inputs for the components the package keeps. A complete `sourceArchive` given explicitly is used unchanged. Source export does not download anything.

When `inputs.art` is omitted, `artBuild.sdk` and `artBuild.fetched` provide the recorded versions of the Android SDK and NDK and the fetched source inputs for AIM's original ART build graph. Other build options:

| Option | Effect |
| --- | --- |
| `buildWork` | Selects the reusable workspace |
| `artBuild.jobs` | Limits parallel compilation (default 4) |
| `artBuild.jdk`, `artBuild.python` | Select the declared build tools |
| `runner.precise` | Reuses existing static CPU archives and notices; without it, the Unicorn source in the checkout provides that component |

The producer prepares the original AIM source with mutable code enabled and passes the runner to the ART producer. Supplied translator, ARM32, framework and image inputs keep their usual roles. Building does not publish a package or change a catalog.

### Catalogs and images

The `android` catalog contains the shared framework and JVM runtime, and the separate `android-art` catalog contains the ART adapter with its native services and helpers. The two projects have separate versions, release tags and archive names. The native runtime, the ART producers and the ART package assembly are part of the MacLauncher Android source project.

The `android-art` package does not contain the Android system image; MacLauncher downloads Google's original image separately. MacLauncher's [Android](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/ANDROID.md) page describes how games use the runtime.

The source project records its upstream checkouts and build prerequisites. Android images, toolchains and portable dependency artifacts are separate inputs and are not in its Git history. Framework and image updates stay on Android 16 (API 36).

## Package tools

A package is made from a finished runtime directory and its declaration, a JSON file that records the runtime's name and version, architecture, macOS requirement, manifest, corresponding source, file permissions, checksums and notices. `pack` checks every input file against the declaration, writes the archive as a stream and then verifies the result without running any runtime code.

```sh
node tools/runtime-package.mjs pack --project android \
  --input /absolute/path/to/sealed-runtime \
  --declaration /absolute/path/to/declaration.json \
  --output out/android-0.1.0-arm64.tar.gz

node tools/runtime-package.mjs verify --project android \
  --version 0.1.0 --arch arm64 \
  --archive out/android-0.1.0-arm64.tar.gz \
  --sha256 <archive-sha256>

node tools/runtime-package.mjs catalog --project android \
  --package out/android-0.1.0-arm64.tar.gz.json \
  --output catalogs/android.json
```

When the catalog already exists, the catalog command also takes `--previous catalogs/android.json` and keeps the versions already published there; it accepts repeated `--package` arguments for releases of the same project. When a declaration file holds an array, the `--project` value selects the entry. `verify` requires the expected project, version and architecture as well as the archive checksum, and the archive's internal record must match all three.

An archive contains `runtime-package.json` and the runtime's files, unchanged, under `files/`. The format supports native executables, shared libraries, Java runtime data and included helpers, and the tools reject paths outside the package, aliases, extra files, mismatched permissions or checksums, and declarations marked for local use only.

`npm test` checks package round trips, producer selection, the history of published catalog records and the rejection of altered, unsafe or incorrectly identified packages.

## Upstream checks and runtime updates

Upstream metadata checks run only when a maintainer starts them:

```sh
node tools/check-updates.mjs --project impacto
node tools/check-updates.mjs --all --output out/upstream-updates.json
```

For each project, the checker reports the recorded upstream commit, the upstream HEAD, recent release metadata and a comparison link. For GitHub releases, it reports both the newest published release, which may be a prerelease, and the newest stable release among the ten most recent records. Queries for a source shared by several projects are reused. GitHub metadata requests use `GH_TOKEN` or `GITHUB_TOKEN` when one is set, and public Git refs and release feeds serve as fallbacks. Release feeds do not distinguish stable releases from prereleases. The report says when metadata is missing, and it lists this repository's own helpers and prebuilt artifacts separately.

The checker changes nothing: recorded commits, catalogs and builds stay as they are. Moving a project to a new upstream commit is a manual change to its producer and to MacLauncher's adaptations of that code.

### Native dependency packaging

[`tools/seal-runtime.mjs`](../tools/seal-runtime.mjs) turns a freshly compiled executable into a finished runtime directory. A recipe supplies the registered project, the package architecture, the exact upstream commit and its source checkout, the build products and the license notices. The source checkout must match its declared commit before and after packaging, and neither a launcher module registry nor a checksum from an earlier local build is used as an input.

The packager copies every non-system native library that the executable depends on, recursively, keeps only the selected CPU, rewrites library references relative to their packaged locations and signs the copies ad hoc. It finds the highest macOS requirement among all of these libraries and rejects a package whose requirement is above the recipe's target. Original build products stay unchanged. Libraries opened with `dlopen` require an explicit `extraLibraries` input, and complete frameworks or application resources belong in declared payloads. A finished output contains `payload/manifest.json`, `payload/files/` and `declaration.json`.

The [graphics recipe](../tools/build-graphics.mjs) builds the core and its declared providers, installs the [Python build tools](../producers/maclauncher/scripts/graphics-build-requirements.txt) at their recorded versions in an isolated environment, and writes a package for one architecture without changing the producer's selected runtime. For the Intel package, its libplacebo and Slang helpers are compiled for Intel directly.

The [Innoextract recipe](../tools/build-innoextract.mjs) builds the extractor and its JSON inspection companion for the selected CPU, using Boost sources and headers at recorded versions, XZ headers and the compression libraries of the macOS SDK. The [System3 recipe](../tools/build-system3.mjs) builds the shared SDL and font libraries for that CPU and packages the resources that the executable loads from beside it. Both recipes use the native packager to collect and package the libraries they depend on.

The [GameMaker 8 decompiler recipe](../tools/build-gm8-decompiler.mjs) compiles MacLauncher's adaptation of the decompiler's Rust workspace with the exact dependency versions in its Cargo lock file, then uses this packager. [APK metadata](../tools/build-apk-metadata.mjs), [Android integration JARs](../tools/build-android-launcher.mjs), [Java Steamworks](../tools/build-java-steamworks.mjs), [LuaSteam](../tools/build-luasteam.mjs) and the [iOS storage adapter](../tools/build-ios-helper.mjs) have separate build commands. Their finished helper manifests include the file list that MacLauncher reads. Java Steamworks keeps the publisher's JNI libraries and compiles MacLauncher's own Java loader, and the Android JAR recipe compiles against a public Android API archive with a recorded checksum.
