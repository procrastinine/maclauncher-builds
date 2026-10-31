# Runtime releases

Every project has its own versions, tags and binary downloads, and releasing one project builds nothing else. A release starts from a finished runtime directory or a publisher's binary. Compiling is a separate step done by the project's [producer](PACKAGES.md), whose files are in the `sourceDirectory` named in the [project registries](PACKAGES.md#projects-and-packages). For a project with a GitHub build command, a [GitHub Actions workflow](#github-builds) builds each newly declared version on its selected GitHub-hosted image and prepares the release from the result.

## GitHub builds

A GitHub Actions workflow, **Runtime build**, compiles packages for every project whose registry entry has a `build` record. The workflow runs when a push to `main` changes `projects.json` or a project registry, and it can also be started by hand for one project; other commits build nothing. A project with several incompatible ABI versions, such as Java Steamworks, can have an array of build records, each with its own command and architectures. An array also serves a project whose architectures have different package revisions: the System3 decompiler builds `0.5.0-MCLv1` for Intel and `0.5.0-MCLv2` for Apple Silicon.

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

A manual run takes the project, an architecture and an operation, `build` or `stage`, and builds the declared versions that still lack a package. The optional version input selects one record when a project declares several. The architecture is `arm64`, `x64` or `universal`, or `all`, which selects every listed architecture that the version still lacks. Naming an architecture that the version already has stops the run.

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

Every build script makes the same checks before it compiles anything, whether `build-runtime.mjs` starts it or it runs on its own. The script must be the command registered for the project, the version and architecture must appear in its `build` record, the output directory must be new, and the work directory must be separate from it. The host must have the runner's OS and run programs for the runner's CPU. A Mac with Apple Silicon can also build Intel packages locally through Rosetta, but a GitHub job always prepares the exact runner.

The job then runs `prepare` with the exact source commit and `verify`, adds a signed GitHub build attestation for the package archive and uploads the release directory as the workflow artifact `runtime-<project>-<version>-<arch>`. A failed attestation request is retried once after five seconds without rebuilding. If both attempts fail, the job fails. Verified release directories are retained as Actions artifacts even when attestation fails; publication still requires a successful package job and a valid attestation. The attestation names this workflow, its run and the commit the package was built from, and `gh attestation verify <archive> --repo procrastinine/maclauncher-builds` checks it.

A manual **Runtime build** run also offers a `stage` operation. It adds a final job, which runs only on `main` and only after every build job has succeeded. That job stages one draft release per architecture, each tagged `<project>/v<version>/<arch>` at the commit that the packages were built from. Nothing is published until the [Runtime release](#draft-upload-and-publication) workflow publishes the drafts. A successful package job from a push build already has the same release artifacts; the `stage` operation of **Runtime release** stages those artifacts directly without compiling again.

The build and packaging commands also run locally. `--prepare` requires the declared host; local cross-compilation can call the exported `prepareBuild` function with `verifyHost: false`. Package records retain the actual toolchain observations. `--plan` prints the job list that the workflow uses, either for one project or for the changes since a given commit:

```sh
node tools/build-runtime.mjs --plan --project sys3-decompiler
node tools/build-runtime.mjs --plan --before <40-character-previous-commit>
node tools/init-runtime-sources.mjs --project sys3-decompiler --version 0.5.0-MCLv2
node tools/build-runtime.mjs --project sys3-decompiler --arch arm64 --version 0.5.0-MCLv2 \
  --output /absolute/path/to/new-build --work /absolute/path/to/new-work
```

## Verification and rebuild comparison

[Verifying packages](../VERIFYING.md) explains how to check the build record that GitHub signs for each package and how to rebuild a package for comparison. The [package verification table](https://procrastinine.github.io/maclauncher-builds/verification.html) is generated from the same catalogs as the package index, with one row for each version and CPU build that shows its minimum macOS, recipe commit, build run and recorded rebuild result. [App feature requirements](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) describe which features can use those packages.

The manual **Rebuild and compare** workflow verifies a published archive's provenance, selects its exact source commit, and runs that commit's source initialization, build, preparation and verification commands. It writes a Markdown summary and JSON report; it does not stage releases, update catalogs or publish packages. The local equivalent is:

```sh
node tools/rebuild-runtime.mjs --project <project> --version <version> \
  --arch <arch> --install-tools true --output /absolute/path/to/new-comparison
```

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

A new build with changed bytes uses a new package revision. Versions with an `MCLvN` component advance that number; versions without one append `-MCLv1`. The upstream engine version, source commit and runtime profile remain unchanged when only packaging or the build producer changes. Previous catalog records, release tags and assets retain their original identity. The existing release and catalog commands append the new revision without replacing an earlier package.

A tag has the form `<project>/v<version>/<arch>` and points to the commit of this repository that the package was built from. That commit contains the matching source, patches, build recipes and the exact upstream commits of every dependency. Submodule source is available through a recursive Git checkout; GitHub's automatic source ZIP files leave it out.

The archive checksum and size are stored in `catalogs/<project>.json`, together with checksums of the source. Because the tagged commit holds the source, releases do not carry a separate source archive.

Tags and archive names follow one rule:

| Name | Form |
| --- | --- |
| Tag | `<project>/v<version>/<arch>` |
| Archive | `<project>-<version>-<arch>.tar.gz` |

The package's file list and the runtime manifest that MacLauncher reads contain that exact version. The architecture appears only as the final component: `arm64`, `x64` or `universal`.

A changed package with the same engine source receives a new `MCLvN` revision: `26.10-MCLv1`, for example, becomes `26.10-MCLv2`. A version without that suffix adds `-MCLv1`. Each revision has its own immutable tag, archive and catalog record. Older catalog rows and installed versions remain available; the ordinary catalog resolver chooses among the compatible versions. Recipe-only changes do not designate a new package build.

Each catalog record also lists, in `launcherArchitectures`, the Mac CPUs on which MacLauncher can use the package. An `arm64` package lists `arm64`, and a universal package lists both CPUs. An `x64` package whose native files run as separate programs lists both CPUs as well, because Apple Silicon runs those programs through Rosetta; its package record marks each such file with `executionArchitecture: "x86_64"`. An `x64` add-on loaded into MacLauncher's own process lists only `x64`, since macOS cannot mix CPU architectures within a process. A library used by a separate Intel host, such as the Steamworks4j 1.9 JNI library in an Intel JVM, can list both with the same `executionArchitecture` record. One version can have a package for each architecture, the catalog keeps all of them, and MacLauncher chooses among them on the Mac where it runs.

### Versions

Packages of tagged upstream versions use `<upstream-version>-MCLvN`, where N is the MacLauncher revision. It starts at 1 for each upstream version: an adaptation change advances `0.7.7-MCLv3` to `0.7.7-MCLv4`, and upstream `0.7.8` starts at `0.7.8-MCLv1`.

Commit snapshots use `MCLvN-MMDD`, where the month and day come from the UTC timestamp of the exact upstream commit. The revision increases with each upstream or adaptation update and continues across years, so `MCLv9-1231` can advance to `MCLv10-0125`. The full timestamp and exact commit stay in the source metadata.

Components maintained in this repository use their own versions. Unmodified publisher files use the publisher’s version without an MCL suffix. Their registered input inventory records the exact supplied files; package manifests and inventories identify the surrounding archive. Older package names keep their original versions. `lib/package-version.mjs` implements the revision calculations for MacLauncher builds.

### Changing a package version

`tools/reversion-runtime.mjs` changes the version in the package's file list and in the runtime manifest by rewriting the archive as a stream. All other file bytes, modes, source checksums, native signatures and dependency records stay the same. The tool takes `--archive`, `--record`, `--version` and a new `--output` path, and the original archive stays unchanged. It does not compile anything. The rewritten package gets a new version and checksum; a published package is never changed. A rewritten compiled package needs a GitHub build attestation for its new digest. A package containing only unchanged publisher files instead requires the registered file-equality authority described below.

### Catalog contents

A project's catalog keeps every published package and gains at most one new version in each publication. Unpublished candidates that a newer one replaced are left out of the records, the producer outputs and the source history. HashLink 1.9 and 1.12, and Steamworks4j 1.9 and 1.10, have separate packages because their game ABIs are incompatible.

## Draft upload and publication

Supplied publisher packages use a separate file-equality authority. A registered prebuilt producer names a public descriptor and its SHA-256. The descriptor pins the original input archive and every supplied file's path, size, hash and mode. `tools/publisher-files.mjs record` compares the actual input and output archives and records their equality in `publisher-records/<archive-sha256>.json`. Additional files are limited to consumed JSON metadata and declared non-executable textual notices. A prebuilt label or locally written success flag grants no publication authority.

`node tools/publisher-files.mjs verify --project <project> --archive <archive> --record <package-record-or-equality-receipt>` rechecks a supplied archive without writing files. Optional `--input-archive` also rechecks the pinned original archive.

Stage and apply recheck the actual supplied archive. Source tags must contain the matching descriptor and producer registration. This records the packaging inputs without claiming compilation on GitHub or authenticated publisher identity; ad-hoc signatures establish no publisher identity. A tag that lacks those inputs cannot authorize another source commit. Compiled packages continue to require signed GitHub build provenance.

`stage` uploads a package through an authenticated GitHub CLI after checking its publication authority. Compiled packages require signed provenance from `runtime-build.yml` on a GitHub-hosted runner. Supplied publisher packages require the registered file-equality record and an actual archive comparison. The archive identity and packaging source must match the package and exact `--target` commit. An existing tag, including an annotated tag, must resolve to that same commit, and a conflicting tag is never replaced. The runtime archive is the only public attachment, and the release notes contain a collapsed Source section that links to the tagged source and the upstream commits. Existing releases and assets are not replaced.

```sh
node tools/release-runtime.mjs stage --bundle out/gemrb-release \
  --target <40-character-builds-source-commit>
```

A manual GitHub Actions workflow, **Runtime release**, takes a project, version and architecture. It keeps the dispatch commit's publication tools and evidence ledger, resolves the historical source tag without changing the checkout, downloads only that draft's binary archive and validates it against the committed catalog. Signed provenance must identify the archive digest and the tag's exact source commit. Its `stage` operation creates a draft from a successful build artifact, `verify` keeps an existing draft, and `publish` publishes the same bytes; none builds native code. The repository's **Source** workflow runs on pushes to `main`, on pull requests and when started by hand; creating a runtime tag does not start it.

Packages built by **Runtime build** are not in the catalog yet. For them, the `build-run` input of **Runtime release** names the ID of the build run. Staging requires that input and a dispatch from `main`; the workflow selects its source commit before creating the tag. The job first confirms that the run is complete and that the selected project, version and architecture have a successful package job. Each package is checked independently. It then downloads the run's artifact for the selected architecture, checks it with `verify`, verifies its GitHub attestation against the build workflow and source commit, and compares it with the draft's asset through `verify-remote` before `publish`. A draft staged locally from the artifact of a push-triggered run, with `stage --target` set to that run's commit, is published the same way without a second build. Each architecture needs its own dispatch. `verify-remote --bundle <directory>` can also be run locally; it reads the release from GitHub and changes nothing.

After publication, the same artifact updates the catalog:

```sh
gh run download <run-id> --repo procrastinine/maclauncher-builds \
  --name runtime-sys3-decompiler-0.5.0-MCLv1-x64 --dir out/sys3-decompiler-x64
node tools/release-runtime.mjs apply --bundle out/sys3-decompiler-x64
```

`apply --bundle <directory>` verifies the applicable publication authority, checks the public release and its source tag, updates the local project catalog and regenerates `catalogs/index.json`. It creates no commit or release and cannot replace an existing package. `stage`, `publish`, `verify-remote`, `apply` and the catalog publication CLI require the applicable publication authority: signed GitHub build evidence for compiled packages, or registered supplied-file equality for unmodified publisher packages. A run ID or locally written success flag is insufficient. Local `prepare` and `verify` remain available for unsigned diagnostic archives. During catalog updates, previous records without either publication authority move to `catalogs/superseded/<project>.json`; their versions and archive identities remain available there. Active catalogs contain the verified incoming package and earlier verified packages. Retiring a catalog entry is a separate, deliberate change, made together with the removal of the corresponding release. MacLauncher reads the per-project catalogs directly from Git, and the package index uses the same committed records.

### Helper packages

`tools/repackage-helpers.mjs` repackages a helper from a finished build and its declaration into a new output directory. The new package keeps the native binaries, the helper metadata that MacLauncher reads and the license notices. The matching source and build recipes are in the release commit.

When a publication leaves out build-only files, the recorded source stays the same: the declaration uses `sourceRelative: null` and keeps the original catalog source checksum. Native protocols, architectures and macOS requirements are preserved.

## Package browser

The [package index](https://procrastinine.github.io/maclauncher-builds/), a GitHub Pages site, lists the committed catalogs with their download links, architectures, minimum macOS versions, source tags and archive checksums. Each package is labeled Apple Silicon, Intel or Universal. Downloadable runtimes and tools are listed apart from bundled components, which are built into the MacLauncher app. Search filters the selected group, and project and ABI links open their matching group automatically.

The `index.json` next to the page contains the same records, explicit page URLs and each project's `delivery` value (`downloadable` or `bundled`). Every release entry there has its `arch` and its `launcherArchitectures`. Project links use `#<project-id>`. Incompatible ABI profiles also have stable anchors, including `#hashlink-1-9`, `#hashlink-1-12`, `#java-steamworks-1-9` and `#java-steamworks-1-10`.

`npm run index:build` generates `index.html`, `index.json`, `verification.html` and `verification.json` without compiling or downloading runtimes. A second workflow, **Package index**, regenerates and deploys the site when the catalogs, either project registry or the index inputs change on `main`. Preparing and publishing an individual runtime stay separate from that workflow.
