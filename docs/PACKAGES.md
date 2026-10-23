# Runtime packages

This reference describes MacLauncher Builds runtime packages, source pins and
build recipes. Commands and paths are relative to the Builds checkout. The
package tools run with Node.js 24 or later and require no Electron app.

The repository contains MacLauncher adaptations and native builds without a
suitable upstream macOS download. Compatible stock binaries are acquired from
upstream. Large implementations have separate source projects, including
`maclauncher-android`; smaller adaptations use pinned sources and owned patches
under `producers/maclauncher/`. Each release attaches only its binary package;
the release tag identifies the matching source, patches and pinned upstream
repositories. Compiled packages are excluded from Git history.

## Projects and packages

[projects.json](../projects.json) selects two project registries:
[downloadable runtimes and tools](../projects/downloadable.json) and
[included components](../projects/bundled.json). Each project belongs to exactly
one registry, which determines its `delivery` classification: `downloadable` or
`bundled`. Project records identify the producer, pinned upstream revisions and
build entries. `readProjects()` resolves both registries into one validated list.

Downloadable runtimes and tools are acquired through MacLauncher when needed or
through Runtimes. Included components are bundled with MacLauncher for offline
use and require no separate installation or setup. The
[package index](https://procrastinine.github.io/maclauncher-builds/) presents
these groups separately; its JSON records expose each project's classification.

The Android producer uses a pinned source submodule. Other producer sources and
patches live under `producers/maclauncher/`. The package tools accept their sealed
outputs. [Per-project catalogs](../catalogs) record published versions, CPU
architectures and archive identities, including separate HashLink profiles.

### Downloadable runtimes

| Project | Package ID | Build contents |
| --- | --- | --- |
| [MacLauncher Android](../sources/maclauncher-android) | `android` | Shared Android framework, JVM execution and native host adaptations |
| [MacLauncher Android ART adapter](../sources/maclauncher-android) | `android-art` | ART execution, compiled framework data, native services and image reader |
| [AIM](https://github.com/hahnlee/aim) | `android-aim` | Private storage, display routing and process integration |
| [AI5 SDL2](https://github.com/nunuhara/ai5-sdl2) | `ai5` | Disc/archive access, save paths and font routing |
| [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) | `butterscotch` | Native AppKit runner and game arguments |
| [FNA](https://github.com/FNA-XNA/FNA) | `fna` | Managed game host, XNA facades and native graphics integration |
| [GemRB](https://github.com/gemrb/gemrb) | `gemrb` | Native command-line entry and scripting-symbol linkage |
| [HashLink](https://github.com/HaxeFoundation/hashlink) | `hashlink` | Legacy 1.9 and 1.12 VM/native-module ABI profiles |
| [impacto](https://github.com/CommitteeOfZero/impacto) | `impacto` | Windows scripts, input, audio, saves and backlog adaptations |
| [Kirikiri SDL2](https://github.com/krkrsdl2/krkrsdl2) | `krkrsdl2` | Storage access, fonts and full-frame presentation |
| [MKXP-Z](https://github.com/mkxp-z/mkxp-z) | `mkxpz` | macOS filename normalization for Apple Silicon |
| [libnpengine](https://github.com/FGRE/libnpengine) | `npengine` | Script compiler, choice handling and native media runner |
| [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN) | `onscripter-en` | Native Cocoa shell and portable SDL/media libraries |
| [ONScripterYuri](https://github.com/YuriSizuku/OnscripterYuri) | `onsyuri` | Empty-page state reset and portable native libraries |
| [OpenGMK](https://github.com/OpenGMK/OpenGMK) | `opengmk` | Native AppKit, graphics, audio and extensions |
| [ReMinori](https://github.com/luoyily/ReMinori) | `reminori` | Fonts, movies, menus, saves and PAZ/PE profiles |
| [System3 SDL2](https://github.com/kichikuou/system3-sdl2) | `system3` | Executable-relative resources and native libraries |
| [xsystem35 SDL2](https://github.com/kichikuou/xsystem35-sdl2) | `xsystem35` | Executable-relative fonts/resources and native libraries |
| [xsystem4](https://github.com/nunuhara/xsystem4) | `xsystem4` | macOS OpenGL/shader support and resource paths |

### Game and extraction tools

| Project | Package ID | Build contents |
| --- | --- | --- |
| [OpenGMK GameMaker 8 decompiler](https://github.com/OpenGMK/OpenGMK) | `gm8-decompiler` | Native macOS build of the original decompiler |
| [innoextract](https://github.com/dscharrer/innoextract) | `innoextract` | Structured installer inspection and bounded parser adaptations |
| [sys3c](https://github.com/kichikuou/sys3c) | `sys3-decompiler` | Native macOS build of the original decompiler |
| [xsys35c](https://github.com/kichikuou/xsys35c) | `xsys35-decompiler` | Native macOS build of the original decompiler |

### Downloadable graphics driver

| Project | Package ID | Build contents |
| --- | --- | --- |
| [KosmicKrisp](https://gitlab.freedesktop.org/mesa/mesa) geometry/transform-feedback adaptation | `vulkan-kosmickrisp-gles32` | MacLauncher geometry-shader and transform-feedback implementation |

This package contains the adapted driver. The stock driver uses upstream binary
delivery.

### Prebuilt runtimes

| Project | Package ID | Artifact |
| --- | --- | --- |
| Adobe Flash Player projector | `flash-projector` | Supplied 35.0.0.60 app, universal ARM64 and Intel |

The Flash projector preserves its supplied universal binary, app bundle and
notices. MacLauncher installs the package through managed runtime delivery and
reuses an installed copy offline.

The MKXP-Z Builds package adds Unicode filename normalization for Apple Silicon
at the original filesystem boundary. Its producer is
`producers/maclauncher/scripts/build-mkxpz-nfc.cjs`, with the pinned patch recorded in
`producers/maclauncher/src/modules/rgss/overlays/mkxpz-filename-nfc/source.json`.
The release tag contains the matching recipe, owned patch and pinned upstream
source. Source checksums remain provenance; no source archive is attached to the
binary release. `runtimes/mkxpz/baseline.json` records the publisher input identity.
Publisher releases and optional authenticated downloads remain available through
the upstream provider rather than duplicate Builds catalog entries.

### Included components

These components ship inside MacLauncher and work offline. They have no separate
runtime installation or setup flow. Their versioned archives supply the app's
build inputs.

| Project | Package ID | Build contents |
| --- | --- | --- |
| MacLauncher graphics | `reshade` | Shared Metal/OpenGL/Quartz presentation and FX, Slang and MPV shader processing |
| Android APK metadata reader | `android-apk-metadata` | Local APK package and manifest inspection |
| Android privacy helper | `android-privacy` | Process-scoped clipboard broker |
| CatSystem2 KIF cryptography helper | `catsystem2-kif-crypto` | CommonCrypto KIF block adapter |
| PlayTools storage adapter | `ios-playtools-paths` | Private paths and device identity |
| [LuaSteam](https://github.com/uspgamedev/luasteam) LÖVE bridge | `love-luasteam` | Version 4 binding against the selected host Lua VM |
| MKXP-Z configuration helper | `mkxpz-config-helper` | Per-game configuration-path adapter |
| Steam API compatibility helper | `steam-api-helper` | Local offline ABI and storage implementation |
| Steam ticket availability adapter | `steam-ticket-loader` | Reject-only encrypted-ticket loader ABI |
| Java Steamworks compatibility libraries | `java-steamworks` | Steamworks4j 1.9 and 1.10 JNI ABI profiles |

The MKXP-Z helper contains MacLauncher integration code. The MKXP-Z runtime is a
separate downloadable package.

## Project and version identities

Each project has a separate catalog at `catalogs/<project-id>.json`. Catalog
schema 2 names that project explicitly and contains only its package records.
The project, version and package architecture determine every release identity:

| Field | Example |
| --- | --- |
| Project | `android` |
| Version | `0.1.0` |
| Architecture | `arm64` |
| Release tag | `android/v0.1.0/arm64` |
| Archive | `android-0.1.0-arm64.tar.gz` |
| Catalog | `catalogs/android.json` |

Records include the archive size/checksum, manifest/source checksums, launcher
architectures and minimum macOS version. Download URLs must match the registered
release repository, project, tag and archive filename. Catalog generation rejects
mixed projects and duplicate version/architecture pairs. Existing published
versions are immutable: changed bytes or metadata require a new package version.
Tagged upstream packages use `1.2.3-MCLv1`, with the revision restarting at 1 for
a new upstream version. Commit snapshots use `MCLv1-MMDD` and increase their
revision across upstream and adaptation changes. The [release reference](RELEASES.md)
defines these version rules and metadata-only package rewriting.

Catalog generation can merge records through `--previous`. Published catalogs
retain the current package per runtime or incompatible game ABI; retired
generations are removed deliberately along with their release assets.
Neither the package tools nor MacLauncher's catalog reader infer an update from
version text or select a different installed version automatically.

## Android producer

The Android recipe pins `sources/maclauncher-android` to an exact source commit.
Builds require that original, clean checkout and explicit build input paths.

```sh
git submodule update --init sources/maclauncher-android
node tools/build-runtime.mjs --project android --check
node tools/build-runtime.mjs --project android --inputs /absolute/path/to/build-inputs.json
node tools/build-runtime.mjs --project android-art --check
node tools/build-runtime.mjs --project android-art --inputs /absolute/path/to/art-inputs.json
```

A build command resolves the selected project's registered producer. Projects
under `producers/maclauncher/` identify their build entries; prebuilt projects retain
the supplied artifact. A different project's producer is never substituted.

The ART command uses the same pinned Android source checkout and its ART
producer entries. ART inputs contain the existing `buildArt` options plus
`sources` with absolute `source`, `klepton` and `glesHeaders` paths, and optional
`runner` build options. The canonical `tools/build-art.mjs` producer returns the
supplier root and its corresponding `sourceArchive`. Without an explicit archive,
`sources.aosp` supplies the original AOSP source subsets selected by AIM's ART
source lock. Registered additional component source checkouts can be supplied
through `sourceCheckouts`. The source exporter reuses the normal HWUI and native
bridge source inputs. `hwuiSources` and `nativeBridgeSources` select original
inputs for retained components; an explicit complete `sourceArchive` remains
unchanged. Source export performs no downloads.

When `inputs.art` is omitted, `artBuild.sdk` and `artBuild.fetched` provide the
pinned Android SDK/NDK and fetched source inputs for AIM's original ART graph.
`buildWork` selects its reusable workspace; `artBuild.jobs` bounds compilation
(default 4), and `artBuild.jdk`/`artBuild.python` select the declared build tools.
The producer prepares original mutable-code ownership and supplies
the bounded runner to the ART producer. Existing static CPU archives and notices
can be reused through `runner.precise`; otherwise the pinned Unicorn source
provides that component. Supplied translator, ARM32, framework and image inputs
retain their existing producer roles. Building does not publish a package,
change a catalog or select an installed runtime.

The `android` catalog contains the shared framework and JVM runtime. The separate
`android-art` catalog contains the ART adapter and its native services and helpers.
The pinned MacLauncher Android source project owns the native runtime, ART
producers and ART package assembly. Adapters in
[MacLauncher](https://github.com/procrastinine/maclauncher) bind launcher metadata
and shared packaging services through the entries recorded in the project
registry. Project routing, versions, release tags and archive names remain separate.

The original Google Android system image is downloaded from upstream after
explicit confirmation. It is not included in the `android-art` release payload.
Installed adapters and previously acquired images remain available offline.

The source project records its upstream checkouts and build prerequisites.
Android images, toolchains and portable dependency artifacts are separate inputs;
they are excluded from source Git history. Framework and image updates preserve
the selected Android API contract.

## Package tools

Existing sealed runtime declarations are the package input. A declaration binds
the runtime identity, architecture, macOS requirement, manifest, corresponding
sources, file permissions, checksums and notices. Package creation verifies the
complete input inventory before writing a streaming archive, then verifies the
result without executing runtime code.

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

For an existing catalog, the catalog command also takes
`--previous catalogs/android.json`. It accepts repeated `--package` arguments
for releases of the same project. Declaration arrays are selected by the
explicit project ID. Verification requires the expected project, version and
architecture in addition to the archive checksum; the archive's internal
identity must match all three.

Archives contain `runtime-package.json` and the original sealed files under
`files/`. The format supports native executables, shared libraries, Java runtime
data and included helpers. It rejects paths outside the package, aliases, extra
files, mismatched permissions/checksums and declarations restricted to local use.

## Upstream checks and runtime updates

Upstream metadata checks are explicit maintainer commands:

```sh
node tools/check-updates.mjs --project impacto
node tools/check-updates.mjs --all --output out/upstream-updates.json
```

The checker reports each project's selected source revision, upstream HEAD,
recent release metadata and comparison link. GitHub release results distinguish
the newest published release, including prereleases, from the newest stable
release in the ten most recent records. Shared source queries are reused across
projects. GitHub metadata uses an optional `GH_TOKEN` or `GITHUB_TOKEN`; public
Git refs and release feeds provide fallbacks. Release feeds do not distinguish
stable releases from prereleases. Missing metadata is reported explicitly.
Owned helpers and pinned prebuilt artifacts are identified separately. The
checker changes no pins, catalogs, builds or installed versions. New upstream
revisions require deliberate integration with the project's adaptations and ABI.

Catalog refresh and runtime installation are separate explicit actions.
Startup and Play retain the selected installed version. First use can request
consent to acquire a missing runtime, install it automatically and resume Play.
Installed packages remain usable offline. There are no background update checks.

`npm test` checks package round trips, producer selection, immutable catalog
history and rejection of altered, unsafe or incorrectly identified packages.
