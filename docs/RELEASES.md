# Runtime releases

Every project has its own versions, tags and binary downloads. A source push declares the packages that GitHub builds and publishes. The project's [producer](PACKAGES.md) supplies the source recipe, exact upstream inputs and package layout. GitHub-hosted workflows build the designated outputs, verify their provenance, publish their immutable archives and commit the catalogs that the package index reads.

## GitHub builds

A GitHub Actions workflow, **Runtime build**, compiles packages for every project whose registry entry has a `build` record. The workflow runs when a push to `main` changes `projects.json` or a project registry; recipe-only commits do not designate additional builds. A project with several incompatible ABI versions, such as Java Steamworks, can have an array of build records, each with its own command and architectures. An array also serves a project whose architectures have different package revisions: the System3 decompiler builds `0.5.0-MCLv1` for Intel and `0.5.0-MCLv2` for Apple Silicon.

| `build` field | Contents |
| --- | --- |
| `version` | Package version that the command produces, also declared in the project's package profiles |
| `command` | Node.js build script in the producer's `sourceDirectory` or in `tools/` |
| `architectures` | Distinct package outputs: `arm64`, `x64` or `universal`; graphics declares both `universal` and `x64` |
| `submodules` | Source submodules that each build job initializes |
| `recursiveSubmodules` | Initialize nested submodules as well; omitted unless the producer uses them |
| `tools` | Declared host tools installed before source initialization |
| `rustComponents` | Rust toolchain components, including `rust-docs` for standard-library license notices |
| `rustTargets` | Rust CPU targets installed before compilation |
| `runners` | Optional package-architecture-to-hosted-image map; otherwise the standard Mac runner for that CPU |
| `cleanupRunner` | Optional boolean, default `false`; remove unused hosted software while preserving the selected toolchain and declared tools |

For a push, a planning job compares each `build` record with the same record in the previous commit and selects those whose version is new or whose architectures grew. From each selected record it leaves out every architecture that already has a catalog record or a release tag for that version. A staged draft already has its tag, so a package is never built twice, and an empty plan starts no build job. Raising `version` therefore builds the new version, and adding `x64` to the architectures of a published version builds only its Intel package.

Each selected record names its project, version and package architectures. A project with several build records retains its incompatible ABI lines separately. The planner leaves out package identities already present in a catalog or release tag.

Each build job uses the OS and CPU declared for its selected GitHub-hosted image. Without a `runners` selection, a package builds on a Mac with its own CPU, and a universal package builds on Apple Silicon.

| Runner label | OS and CPU | Default for | Xcode | Developer directory | macOS SDK |
| --- | --- | --- | --- | --- | --- |
| `xcode-27` | macOS, Apple Silicon | Apple Silicon and universal packages | 27.0 | `/Applications/Xcode_27.0.app/Contents/Developer` | 27.0 |
| `macos-26-intel` | macOS, Intel | Intel packages | 26.6 | `/Applications/Xcode_26.6.app/Contents/Developer` | 26.5 |
| `ubuntu-24.04` | Linux, x64 | | | | |
| `ubuntu-24.04-arm` | Linux, Arm | | | | |

After checkout and Node setup, `node tools/build-runtime.mjs --prepare` checks the selected image's OS and CPU. On a Mac it selects Xcode through `DEVELOPER_DIR` and checks the Xcode and macOS SDK versions. Hosted preparation selects the declared Xcode installation. Local preparation keeps an explicit `DEVELOPER_DIR` and checks the same required version. An explicit `SDKROOT` selects the SDK checked and used for compilation. The same command installs declared tools and the Rust toolchain, initializes declared sources, and records environment and PATH settings for the later steps.

The [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists the CPU types for these labels. The [Xcode 27 image](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md) supplies SDK 27 on Apple Silicon; the [Intel image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) supplies SDK 26.5. A build record can select `xcode-27`, `macos-26-intel`, `ubuntu-24.04` or `ubuntu-24.04-arm` through `runners`. Linux labels provide x64 and arm64 hosts respectively. Recipes that produce Mac programs use Mac images; data, Java, DEX and guest compilation inputs can use Linux. Host CPU and package architecture are separate facts. Paid and self-hosted images are excluded. The SDK used for compilation is separate from each package's minimum macOS version. Linux runners handle payloads without Mach-O files when the recipe tools are available on Linux. Mac programs stay on Mac runners. Runner changes apply to the next designated build and do not rebuild an existing package.

The `mpv` and `vulkan-kosmickrisp-gles32` source builds use `xcode-27` with Xcode 27.0. The media recipe builds the pinned libmpv source and backports, then compiles its decoded-frame host. KosmicKrisp builds the pinned Mesa driver, Vulkan loader, SPIRV-Tools and Zstandard sources. Its source-built dependency closure targets macOS 26 independently of the macOS 27 build SDK. Both pass their fresh outputs through the shared dependency sealer; package records retain the measured requirements of the complete library closure.

Rust builds select toolchain 1.99.0 explicitly. That selection applies to compilation and dependency-license collection, including source trees with their own older toolchain file.

On macOS, declared tools use Homebrew formulae and their installed dependency closure. On Linux, `tools/build-tools.mjs` maps supported tool names to Ubuntu packages; `uv` uses the version and wheel hashes in `tools/linux-build-requirements.txt`. Unsupported Linux tool names fail before installation. Additional executable searches use declared tools, and inherited library search paths are cleared. Both systems use the same build, preparation, verification and attestation steps.

Every build reports initial disk space. With `cleanupRunner: true`, `tools/cleanup-runner.mjs` reports disk space before and after removing unused hosted software. It retains the selected Xcode and SDK, active language toolchains and declared build tools. Host preparation applies cleanup only in a GitHub-hosted environment; local preparation runs the cleanup report without deleting files. Direct cleanup invocation is also a dry run without `--apply`.

Version-specific capability facts can be stored in the sealed manifest. Packaging validates their shape and copies them into the catalog record alongside any project-wide defaults. HashLink uses this path for its bytecode and native-module ABI facts.

Before compilation, `tools/init-runtime-sources.mjs` initializes the declared source paths. It follows each registered Git submodule in a nested path and applies recursive initialization only to a declared leaf that requests it. Servers without shallow-fetch support use a full fetch of the same pinned source.

The job runs the build script through `tools/build-runtime.mjs`, which selects the declared version and passes `--project`, `--arch`, `--output` and `--work`; a command with several build records also receives `--version`. When the script finishes, its output directory must hold exactly two entries, the finished runtime in `payload/` and its package declaration in `declaration.json`. `build-runtime.mjs` rejects any other layout, a version other than the one in the `build` record, an architecture that the project does not build and a declaration whose Mac CPUs do not match its architecture.

Every build script makes the same checks before it compiles anything, whether `build-runtime.mjs` starts it or it runs on its own. The script must be the command registered for the project, the version and architecture must appear in its `build` record, the output directory must be new, and the work directory must be separate from it. The host must have the runner's OS and run programs for the runner's CPU. A Mac with Apple Silicon can also build Intel packages locally through Rosetta, but a GitHub job always prepares the exact runner.

Every build script makes the same checks before it compiles anything, whether `build-runtime.mjs` starts it or it runs on its own. The script must be the command registered for the project, the version and architecture must appear in its `build` record, the output directory must be new, and the work directory must be separate from it. The host must have the runner's OS and run programs for the runner's CPU. A Mac with Apple Silicon can also build Intel packages locally through Rosetta, but a GitHub job always prepares the exact runner. Build scripts take each build tool from the project's declared Homebrew formulae first, then from the build's `PATH`. That `PATH` holds only Xcode's compilers, the declared formulae, a few host tools such as Node and Rust, and the system directories, so a build script does not pick up an undeclared Homebrew tool.

The job then runs `prepare` with the exact source commit and `verify`, adds a signed GitHub build attestation for the package archive and uploads the release directory as the workflow artifact `runtime-<project>-<version>-<arch>`. A failed attestation request is retried once after five seconds without rebuilding. If both attempts fail, the job fails. Verified release directories are retained as Actions artifacts even when attestation fails; publication still requires a successful package job and a valid attestation. The attestation names this workflow, its run and the commit the package was built from, and `gh attestation verify <archive> --repo procrastinine/maclauncher-builds` checks it.

Completion of **Runtime build** triggers **Runtime release** through GitHub's `workflow_run` event. Publication uses the successful package artifacts from that run; it does not compile them again. No local dispatch, artifact transfer or publication command is part of the release path.

The build and packaging commands also run locally. `--prepare` requires the declared host; local cross-compilation can call the exported `prepareBuild` function with `verifyHost: false`. Package records retain the actual toolchain observations. `--plan` prints the job list that the workflow uses, either for one project or for the changes since a given commit:

```sh
node tools/build-runtime.mjs --plan --project sys3-decompiler
node tools/build-runtime.mjs --plan --before <40-character-previous-commit>
node tools/init-runtime-sources.mjs --project sys3-decompiler --version 0.5.0-MCLv2
node tools/build-runtime.mjs --project sys3-decompiler --arch arm64 --version 0.5.0-MCLv2 \
  --output /absolute/path/to/new-build --work /absolute/path/to/new-work
```

### Supplied publisher packages

A project whose prebuilt producer registers a [publisher input](#supplied-publisher-verification) assembles the registered publisher version from that exact input on a GitHub-hosted runner. The hosted job checks the input archive's size, SHA-256 and complete supplied-file inventory. It writes only the surrounding package metadata and declared notices; the publisher's files retain their bytes and modes.

The workflow records supplied-file equality and verifies the sealed package. Unmodified publisher files do not require a build attestation; their authority is the exact file-equality record. This comparison does not establish publisher authentication or turn an ad-hoc signature into a Developer ID signature. Compiled and supplied packages use the same hosted publication boundary, with their distinct verification requirements.

## Verification and rebuild comparison

[Verifying packages](../VERIFYING.md) explains how to check the build record that GitHub signs for each package and how to rebuild a package for comparison. The [package verification table](https://procrastinine.github.io/maclauncher-builds/verification.html) is generated from the same catalogs as the package index, with one row for each version and CPU build that shows its minimum macOS, recipe commit, build run and recorded rebuild result. [App feature requirements](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) describe which features can use those packages.

The **Rebuild and compare** workflow verifies a published archive's provenance, selects its exact source commit, and runs that commit's source initialization, build, preparation and verification commands on GitHub. It writes a Markdown summary and JSON report; it does not publish packages or change catalogs. Local verification can compare already available archives without downloading or publishing them.

A historical package without a registered build command uses the producer entry in its tagged project record for manual reproduction. Rebuilds use the recorded commit's host-preparation helper and tool installer when present, and retain its packaging implementation. Earlier Mac recipes retain their original Homebrew installation commands. Recipe-only edits do not designate a build or change published packages; the push plan selects new versions or additional explicitly declared architectures.

The report compares complete archive hashes, regular-file hashes and permissions, tar headers, member order and the full decompressed tar stream. JSON differences include field pointers and distinguish missing fields from null values. Toolchain observations appear separately from file differences. A binary difference whose cause is not established remains unexplained; an SDK difference does not establish executable equivalence.

New preparation with `--source-revision` uses the commit timestamp for `SOURCE_DATE_EPOCH` and tar timestamps. Archive entries have fixed owner IDs and retain the sealed declaration's permissions; the inventory is first and the remaining members are sorted by UTF-8 bytes. Gzip settings and header fields are explicit. Legacy preparation and existing-archive reuse retain their established bytes. Runtime archives use gzip; a bundled zstd library is a binary dependency, not an archive-compression setting.

New package sidecars record `build.sourceRevision`, the build workflow, GitHub run/attempt when present, and observed Node, zlib, selected clang, Xcode and macOS SDK versions. Component receipts retain their actual dependency/compiler information. Run timestamps and host installation paths are omitted from newly generated portable receipts. These records remain outside the runtime archive, so a run ID does not change its bytes.

Catalog `build` metadata identifies the Builds recipe separately from an upstream `source` pointer. Optional `rebuild` metadata records `status` (`match` or `different`), the recipe commit, both archive hashes and a GitHub Actions report URL. Publication validates the original hash against the immutable asset and rejects a claimed match with different hashes. Missing historical evidence stays absent; a table link to an attestation lookup does not assert that a signed statement exists.

## Local preparation

`tools/release-runtime.mjs prepare` runs offline. Its input is either a finished runtime directory with a declaration file, or the output of a MacLauncher runtime manager, which contains `manifest.json` and `files/`. Preparation keeps the runtime's files, the CPU architectures of its native binaries and its file modes unchanged.

```sh
node tools/release-runtime.mjs prepare --project gemrb \
  --input /absolute/path/to/sealed-manager-output \
  --output out/gemrb-release

node tools/release-runtime.mjs prepare --project android \
  --input /absolute/path/to/sealed-runtime \
  --declaration /absolute/path/to/declaration.json \
  --output out/android-release
```

`--archive` and `--record` reuse an existing package without compressing it again. When a declaration file holds an array, the `--project` value selects the entry. The output directory contains the runtime archive, its package record (a JSON file next to the archive) and a snapshot of the project catalog. `--source` keeps a separate source archive locally for package validation; source archives are not attached to the binary-only release.

`verify --bundle <directory>` checks the archive and its record against the package's complete file list without running anything in the runtime. `--project`, `--version` and `--arch` also check those values explicitly.

## Source and release identity

A new build with changed bytes uses a new package revision. Owned products advance their plain semantic version. Upstream-derived packages advance their `MCLvN` revision while retaining the original upstream release or snapshot identity. Unmodified publisher packages retain the publisher version. The upstream engine version, source commit and runtime profile remain unchanged when only packaging or the build producer changes. Previous catalog records, release tags and assets retain their original identity. The existing release and catalog commands append the new revision without replacing an earlier package.

A tag has the form `<project>/v<version>/<arch>` and points to the commit of this repository that the package was built from. That commit contains the matching source, patches, build recipes and the exact upstream commits of every dependency. Submodule source is available through a recursive Git checkout; GitHub's automatic source ZIP files leave it out.

The archive checksum and size are stored in `catalogs/<project>.json`, together with checksums of the source. Because the tagged commit holds the source, releases do not carry a separate source archive.

Tags and archive names follow one rule:

| Name | Form |
| --- | --- |
| Tag | `<project>/v<version>/<arch>` |
| Archive | `<project>-<version>-<arch>.tar.gz` |

The package's file list and the runtime manifest that MacLauncher reads contain that exact version. The architecture appears only as the final component: `arm64`, `x64` or `universal`.

A changed package with the same engine source receives a new `MCLvN` revision: `26.10-MCLv1`, for example, becomes `26.10-MCLv2`. An upstream-derived version without that suffix adds `-MCLv1`; an owned product instead advances its plain semantic version. Each revision has its own immutable tag, archive and catalog record. Older catalog rows and installed versions remain available; the ordinary catalog resolver chooses among the compatible versions. Recipe-only changes do not designate a new package build.

Each catalog record also lists, in `launcherArchitectures`, the Mac CPUs on which MacLauncher can use the package. An `arm64` package lists `arm64`, and a universal package lists both CPUs. An `x64` package whose native files run as separate programs lists both CPUs as well, because Apple Silicon runs those programs through Rosetta; its package record marks each such file with `executionArchitecture: "x86_64"`. An `x64` add-on loaded into MacLauncher's own process lists only `x64`, since macOS cannot mix CPU architectures within a process. A library used by a separate Intel host, such as the Steamworks4j 1.9 JNI library in an Intel JVM, can list both with the same `executionArchitecture` record. One version can have a package for each architecture, the catalog keeps all of them, and MacLauncher chooses among them on the Mac where it runs.

### Versions

Packages of tagged upstream versions use `<upstream-version>-MCLvN`, where N is the MacLauncher revision. It starts at 1 for each upstream version: an adaptation change advances `0.7.7-MCLv3` to `0.7.7-MCLv4`, and upstream `0.7.8` starts at `0.7.8-MCLv1`.

Commit snapshots use `MCLvN-MMDD`, where the month and day come from the UTC timestamp of the exact upstream commit. The revision increases with each upstream or adaptation update and continues across years, so `MCLv9-1231` can advance to `MCLv10-0125`. The full timestamp and exact commit stay in the source metadata.

Components maintained in this repository use their own versions. Unmodified publisher files use the publisher’s version without an MCL suffix. Their registered input inventory records the exact supplied files; package manifests and inventories identify the surrounding archive. Older package names keep their original versions. `lib/package-version.mjs` implements the revision calculations for MacLauncher builds.

### Changing a package version

`tools/reversion-runtime.mjs` changes the version in the package's file list and in the runtime manifest by rewriting the archive as a stream. All other file bytes, modes, source checksums, native signatures and dependency records stay the same. The tool takes `--archive`, `--record`, `--version` and a new `--output` path, and the original archive stays unchanged. It does not compile anything. The rewritten package gets a new version and checksum; a published package is never changed. A rewritten compiled package needs hosted provenance for its new archive digest. Unmodified publisher files instead require the registered file-equality authority described below. Local rewriting produces diagnostic files only; it does not authorize publication.

### Catalog contents

A project's catalog keeps every published package and gains at most one new version in each publication. Unpublished candidates that a newer one replaced are left out of the records, the producer outputs and the source history. HashLink 1.9 and 1.12, and Steamworks4j 1.9 and 1.10, have separate packages because their game ABIs are incompatible.

<a id="draft-upload-and-publication"></a>

## Automatic publication on GitHub

The **Runtime release** workflow starts automatically when **Runtime build** completes. It obtains the triggering run ID and exact source commit from GitHub's `workflow_run` event. The source push is the release input; a local dispatcher, downloaded Actions artifact or locally staged upload is not part of this path.

<a id="publish-verified-builds-on-github"></a>

### Verification and publication

The hosted controller selects successful package jobs from the completed run and checks the project, version, architecture and source commit. It downloads their artifacts inside the GitHub-hosted checkout, verifies each archive's digest and sealed declaration, and imports compiled-package provenance or supplied-file equality as applicable. A run ID or a locally written success flag is not publication authority. The publication plan records the exact packages selected for publication.

For each selected package, the controller creates or resumes a draft whose tag identifies the certified source commit. It verifies the draft, publishes the same archive bytes, verifies the public release and applies its catalog record. Packages are processed serially and stop at the first failure. A matching existing tag, draft, public archive or catalog entry is reused; a conflicting source commit or archive digest remains an error. Releases, assets and previous installed identities are not replaced.

The archive is the only public release attachment. The package record, signed evidence, supplied-file equality when applicable, sealed declaration and catalog are committed as source records. Release notes link to the tagged source and its exact upstream pins. No compiled archive passes through a local Mac for publication.

After applying the verified records, the workflow commits the catalogs and evidence with the public repository identity. It checks an ordinary clone of that exact catalog commit with the Source checks, version checks and package-index generation before pushing the commit. Its index job calls the existing **Package index** workflow with that catalog commit's SHA, so the deployed index and per-project catalogs describe the same publication.

All publication operations share one hosted queue. A retry preserves matching completed work and checks the same identities again. If an Actions artifact has expired after its release was created, the existing public archive remains acceptable only when its signed digest and package identity match. Recipe changes alone never cause an old version to be rebuilt or reissued.

<a id="publish-one-package"></a>

### Supplied publisher verification

A registered prebuilt producer names a public descriptor and its SHA-256. The descriptor pins the original input archive and every supplied file's path, size, hash and mode. `tools/publisher-files.mjs record` compares the actual input and assembled archives. Added files are limited to consumed package metadata and declared non-executable textual notices. A prebuilt label alone grants no exception.

Publication verifies the exact supplied-file equality record and rechecks the actual supplied bytes. Source tags must contain the matching producer registration and descriptor. No build attestation is required for unchanged publisher files. The comparison identifies the unchanged files, not the publisher's private compilation or identity. Existing ad-hoc signatures remain ad-hoc signatures.

Local checks of already available files remain read-only:

```sh
node tools/release-runtime.mjs verify --bundle /absolute/path/to/existing-release
node tools/publisher-files.mjs verify --project <project> \
  --archive /absolute/path/to/existing-package.tar.gz \
  --record /absolute/path/to/existing-equality-record.json
```

The local `release:stage`, `release:catalog` and `release:batch` publication routes are unavailable. Their CLI entry points require the shared GitHub-hosted publication context before any remote mutation. The batch tool remains a hosted maintenance interface; the automatic workflow uses the shared verified publication controller. Local `prepare` and `verify` can inspect unsigned diagnostic archives without changing a release or catalog.

Applying a package also records its complete sealed declaration in `catalogs/declarations/<project>/<version>/<arch>.json`. File inventories, notices and manifest/source digests come from the verified `runtime-package.json` inside the archive. Conflicting declarations stop publication. These records are readable from Git and are not additional release attachments. Older identities remain in active catalogs or deliberate superseded history; no local catalog rewrite is part of ordinary publication.

### Helper packages

`tools/repackage-helpers.mjs` repackages a helper from a finished build and its declaration into a new output directory. The new package keeps the native binaries, the helper metadata that MacLauncher reads and the license notices. The matching source and build recipes are in the release commit.

When a publication leaves out build-only files, the recorded source stays the same: the declaration uses `sourceRelative: null` and keeps the original catalog source checksum. Native protocols, architectures and macOS requirements are preserved.

## Package browser

The [package index](https://procrastinine.github.io/maclauncher-builds/), a GitHub Pages site, lists the committed catalogs with their download links, architectures, minimum macOS versions, source tags and archive checksums. Each package is labeled Apple Silicon, Intel or Universal. Downloadable runtimes and tools are listed apart from bundled components, which are built into the MacLauncher app. Search filters the selected group, and project and ABI links open their matching group automatically.

The `index.json` next to the page contains the same records, explicit page URLs and each project's `delivery` value (`downloadable` or `bundled`). Every release entry there has its `arch` and its `launcherArchitectures`. Project links use `#<project-id>`. Incompatible ABI profiles also have stable anchors, including `#hashlink-1-9`, `#hashlink-1-12`, `#java-steamworks-1-9` and `#java-steamworks-1-10`.

`npm run index:build` generates `index.html`, `index.json`, `verification.html` and `verification.json` without compiling or downloading runtimes. The **Package index** workflow regenerates and deploys the site when its source inputs change on `main`. Automatic publication also calls it with the exact checked catalog commit. It generates the site without compiling or downloading runtime archives.
