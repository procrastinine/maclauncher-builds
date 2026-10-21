# MacLauncher Builds

Versioned macOS runtime packages, source pins and build recipes for MacLauncher.
The package tools run with Node.js 24 or later and require no Electron app.

The repository contains MacLauncher adaptations and native builds without a
suitable upstream macOS download. Compatible stock binaries are acquired from
upstream. Large implementations have separate source projects, including
`maclauncher-android`; smaller adaptations use pinned sources and owned patches
in MacLauncher. Compiled packages are release assets, excluded from Git history.

## Projects and packages

[projects.json](projects.json) identifies each package, its producer, selected
upstream revisions and release repository. The Android producer uses a pinned
source submodule. Other source producers are maintained in MacLauncher; their
exact build entries are recorded in the registry. The package tools accept their
sealed outputs. [The package inventory](recipes/included-packages.json) records
selected versions and CPU architectures, including multiple HashLink profiles.

### Runtime projects

| Project | Package ID | Build contents |
| --- | --- | --- |
| [MacLauncher Android](sources/maclauncher-android) | `android` | Shared Android framework, JVM execution and native host adaptations |
| [MacLauncher Android ART adapter](sources/maclauncher-android) | `android-art` | ART execution, compiled framework data, native services and image reader |
| [AIM](https://github.com/hahnlee/aim) | `android-aim` | Private storage, display routing and process integration |
| [AI5 SDL2](https://github.com/nunuhara/ai5-sdl2) | `ai5` | Disc/archive access, save paths and font routing |
| [FNA](https://github.com/FNA-XNA/FNA) | `fna` | Managed game host, XNA facades and native graphics integration |
| [GemRB](https://github.com/gemrb/gemrb) | `gemrb` | Native command-line entry and scripting-symbol linkage |
| [HashLink](https://github.com/HaxeFoundation/hashlink) | `hashlink` | Legacy 1.9 and 1.12 VM/native-module ABI profiles |
| [impacto](https://github.com/CommitteeOfZero/impacto) | `impacto` | Windows scripts, input, audio, saves and backlog adaptations |
| [Kirikiri SDL2](https://github.com/krkrsdl2/krkrsdl2) | `krkrsdl2` | Storage access, fonts and full-frame presentation |
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

### Graphics and integration packages

| Project | Package ID | Build contents |
| --- | --- | --- |
| MacLauncher graphics | `reshade` | Shared Metal/OpenGL/Quartz presentation and FX, Slang and MPV shader processing |
| [KosmicKrisp](https://gitlab.freedesktop.org/mesa/mesa) geometry/transform-feedback adaptation | `vulkan-kosmickrisp-gles32` | MacLauncher geometry-shader and transform-feedback implementation |
| Android privacy helper | `android-privacy` | Process-scoped clipboard broker |
| CatSystem2 KIF cryptography helper | `catsystem2-kif-crypto` | CommonCrypto KIF block adapter |
| PlayTools storage adapter | `ios-playtools-paths` | Private paths and device identity |
| [LuaSteam](https://github.com/uspgamedev/luasteam) LÖVE bridge | `love-luasteam` | Version 4 binding against the selected host Lua VM |
| MKXP-Z configuration helper | `mkxpz-config-helper` | Per-game configuration-path adapter |
| Steam API compatibility helper | `steam-api-helper` | Local offline ABI and storage implementation |
| Steam ticket availability adapter | `steam-ticket-loader` | Reject-only encrypted-ticket loader ABI |

The KosmicKrisp entry contains the adapted driver; the stock driver uses upstream
binary delivery. Integration helpers are internal dependencies and retain their
associated runtime's installation flow. The MKXP-Z helper contains MacLauncher
integration code; MKXP-Z itself uses publisher binaries.

### Prebuilt runtime

| Project | Package ID | Artifact |
| --- | --- | --- |
| Adobe Flash Player projector | `flash-projector` | Supplied 35.0.0.60 app, universal ARM64 and Intel |

The Flash projector preserves its supplied binary, app bundle and notices. It
retains both CPU slices and its included offline default in MacLauncher.

## Project and version identities

Each project has a separate catalog at `catalogs/<project-id>.json`. Catalog
schema 2 names that project explicitly and contains only its package records.
The project, version and package architecture determine every release identity:

| Field | Example |
| --- | --- |
| Project | `android` |
| Version | `0.1.0-afdc510a-61332a65` |
| Architecture | `arm64` |
| Release tag | `android/v0.1.0-afdc510a-61332a65/arm64` |
| Archive | `android-0.1.0-afdc510a-61332a65-arm64.tar.gz` |
| Catalog | `catalogs/android.json` |

Records include the archive size/checksum, manifest/source checksums, launcher
architectures and minimum macOS version. Download URLs must match the registered
release repository, project, tag and archive filename. Catalog generation rejects
mixed projects and duplicate version/architecture pairs. Existing published
versions are immutable: changed bytes or metadata require a new package version.
A new package revision can retain the upstream version and append a MacLauncher
revision, such as `1.2.3-ml2`.

Catalog updates retain earlier versions through `--previous`. New records are
listed first, followed by earlier records; publisher ordering is preserved.
Neither the package tools nor MacLauncher's catalog reader infer an update from
version text or select a different installed version automatically.

## Android producer

The Android recipe pins `sources/maclauncher-android` to an exact source commit.
Builds require that original, clean checkout and explicit build input paths.

```sh
git submodule update --init sources/maclauncher-android
node tools/build-runtime.mjs --project android --check
node tools/build-runtime.mjs --project android --inputs /absolute/path/to/build-inputs.json
```

A build command resolves the selected project's registered producer. Projects
maintained in MacLauncher identify their build entries; prebuilt projects retain
the supplied artifact. A different project's producer is never substituted.

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
  --output out/android-0.1.0-afdc510a-61332a65-arm64.tar.gz

node tools/runtime-package.mjs verify --project android \
  --version 0.1.0-afdc510a-61332a65 --arch arm64 \
  --archive out/android-0.1.0-afdc510a-61332a65-arm64.tar.gz \
  --sha256 <archive-sha256>

node tools/runtime-package.mjs catalog --project android \
  --package out/android-0.1.0-afdc510a-61332a65-arm64.tar.gz.json \
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
