# Runtime releases

Every project has its own versions, tags and binary downloads, and releasing one project builds nothing else. A release starts from a finished runtime directory or a publisher's binary. Compiling is a separate step done by the project's [producer](PACKAGES.md), whose files are in the `sourceDirectory` named in the [project registries](PACKAGES.md#projects-and-packages). For a project with a GitHub build command, a [GitHub Actions workflow](#github-builds) compiles each new version on a GitHub-hosted Mac of each CPU type and prepares the release from the result.

## GitHub builds

A GitHub Actions workflow, **Runtime build**, compiles packages for every project whose registry entry has a `build` record. The workflow runs when a push to `main` changes `projects.json` or a project registry, and it can also be started by hand for one project; other commits build nothing. A project with several incompatible ABI versions, such as Java Steamworks, can have an array of build records, each with its own command and architectures.

| `build` field | Contents |
| --- | --- |
| `version` | Package version that the command produces, also declared in the project's package profiles |
| `command` | Node.js build script in the producer's `sourceDirectory` or in `tools/` |
| `architectures` | Distinct package outputs: `arm64`, `x64` or `universal`; graphics declares both `universal` and `x64` |
| `submodules` | Source submodules that each build job initializes |
| `recursiveSubmodules` | Initialize nested submodules as well; omitted unless the producer uses them |
| `tools` | Homebrew formulae that each build job installs |
| `rustComponents` | Rust toolchain components, including `rust-docs` for standard-library license notices |
| `rustTargets` | Rust CPU targets installed before compilation |
| `runners` | Optional architecture-to-hosted-image map; otherwise the standard runner for that CPU |

For a push, a planning job compares each `build` record with the same record in the previous commit and selects those whose version is new or whose architectures grew. From each selected record it leaves out every architecture that already has a catalog record or a release tag for that version. A staged draft already has its tag, so a package is never built twice, and an empty plan starts no build job. Raising `version` therefore builds the new version, and adding `x64` to the architectures of a published version builds only its Intel package.

A manual run takes the project, an architecture and an operation, `build` or `stage`, and builds the declared versions that still lack a package. The optional version input selects one record when a project declares several. The architecture is `arm64`, `x64` or `universal`, or `all`, which selects every listed architecture that the version still lacks. Naming an architecture that the version already has stops the run.

Each build job selects an explicit hosted image and Xcode installation through `DEVELOPER_DIR`. The workflow checks the selected Xcode and macOS SDK versions before initializing sources.

| Package outputs | Runner label | Xcode | Developer directory | macOS SDK |
| --- | --- | --- | --- | --- |
| Apple Silicon and Universal | `xcode-27` | 27.0 | `/Applications/Xcode_27.0.app/Contents/Developer` | 27.0 |
| Intel | `macos-26-intel` | 26.6 | `/Applications/Xcode_26.6.app/Contents/Developer` | 26.5 |

The [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists the CPU types for these labels. The [Xcode 27 image](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md) supplies SDK 27 on Apple Silicon; the [Intel image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) supplies SDK 26.5. A build record can select a hosted image with a declared toolchain through `runners`. The SDK used for compilation is separate from each package's minimum macOS version.

The `mpv` and `vulkan-kosmickrisp-gles32` source builds use `xcode-27` with Xcode 27.0. The media recipe builds the pinned libmpv source and backports, then compiles its decoded-frame host. KosmicKrisp builds the pinned Mesa driver and Vulkan loader. Both pass their fresh outputs through the shared dependency sealer; package records retain the measured requirements of the complete library closure.

Rust builds select toolchain 1.99.0 explicitly. That selection applies to compilation and dependency-license collection, including source trees with their own older toolchain file.

Build commands receive the declared Homebrew formulae and their installed dependency closure. Executable and pkg-config searches use those prefixes and the selected host toolchain, and inherited library search paths are cleared.

Version-specific capability facts can be stored in the sealed manifest. Packaging validates their shape and copies them into the catalog record alongside any project-wide defaults. HashLink uses this path for its bytecode and native-module ABI facts.

Before compilation, `tools/init-runtime-sources.mjs` initializes the declared source paths. It follows each registered Git submodule in a nested path and applies recursive initialization only to a declared leaf that requests it. Servers without shallow-fetch support use a full fetch of the same pinned source.

The job runs the build script through `tools/build-runtime.mjs`, which selects the declared version and passes `--project`, `--arch`, `--output` and `--work`; a command serving several ABI versions also receives `--version`. When the script finishes, its output directory must hold exactly two entries, the finished runtime in `payload/` and its package declaration in `declaration.json`. `build-runtime.mjs` rejects any other layout, a version other than the one in the `build` record, an architecture that the project does not build and a declaration whose Mac CPUs do not match its architecture.

The job then runs `prepare` with the exact source commit and `verify`, adds a signed GitHub build attestation for the package archive and uploads the release directory as the workflow artifact `runtime-<project>-<version>-<arch>`. A failed attestation request is retried once after five seconds without rebuilding. If both attempts fail, the job fails. Verified release directories are retained as Actions artifacts even when attestation fails; publication still requires a successful package job and a valid attestation. The attestation names this workflow, its run and the commit the package was built from, and `gh attestation verify <archive> --repo procrastinine/maclauncher-builds` checks it.

A manual **Runtime build** run also offers a `stage` operation. It adds a final job, which runs only on `main` and only after every build job has succeeded. That job stages one draft release per architecture, each tagged `<project>/v<version>/<arch>` at the commit that the packages were built from. Nothing is published until the [Runtime release](#draft-upload-and-publication) workflow publishes the drafts. A successful package job from a push build already has the same release artifacts; the `stage` operation of **Runtime release** stages those artifacts directly without compiling again.

The same commands run locally. `--plan` prints the job list that the workflow uses, either for one project or for the changes since a given commit:

```sh
node tools/build-runtime.mjs --plan --project sys3-decompiler
node tools/build-runtime.mjs --plan --before <40-character-previous-commit>
node tools/init-runtime-sources.mjs --project sys3-decompiler
node tools/build-runtime.mjs --project sys3-decompiler --arch arm64 \
  --output /absolute/path/to/new-build --work /absolute/path/to/new-work
```

## Verification and rebuild comparison

[Verifying packages](../VERIFYING.md) explains how to check the build record that GitHub signs for each package and how to rebuild a package for comparison. The [package verification table](https://procrastinine.github.io/maclauncher-builds/verification.html) is generated from the same catalogs as the package index, with one row for each version and CPU build that shows its minimum macOS, recipe commit, build run and recorded rebuild result. [App feature requirements](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) describe which features can use those packages.

The manual **Rebuild and compare** workflow verifies a published archive's provenance, selects its exact source commit, and runs that commit's source initialization, build, preparation and verification commands. It writes a Markdown summary and JSON report; it does not stage releases, update catalogs or publish packages. The local equivalent is:

```sh
node tools/rebuild-runtime.mjs --project <project> --version <version> \
  --arch <arch> --install-tools true --output /absolute/path/to/new-comparison
```

A historical package without a registered build command uses the producer entry in its tagged project record for manual reproduction. Rebuilds retain the historical packaging implementation. Recipe-only edits do not designate a build or change published packages; the push plan selects new versions or additional explicitly declared architectures.

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

Each catalog record also lists, in `launcherArchitectures`, the Mac CPUs on which MacLauncher can use the package. An `arm64` package lists `arm64`, and a universal package lists both CPUs. An `x64` package whose native files run as separate programs lists both CPUs as well, because Apple Silicon runs those programs through Rosetta; its package record marks each such file with `executionArchitecture: "x86_64"`. An `x64` add-on loaded into MacLauncher's own process lists only `x64`, since macOS cannot mix CPU architectures within a process. A library used by a separate Intel host, such as the Steamworks4j 1.9 JNI library in an Intel JVM, can list both with the same `executionArchitecture` record. One version can have a package for each architecture, the catalog keeps all of them, and MacLauncher chooses among them on the Mac where it runs.

### Versions

Packages of tagged upstream versions use `<upstream-version>-MCLvN`, where N is the MacLauncher revision. It starts at 1 for each upstream version: an adaptation change advances `0.7.7-MCLv3` to `0.7.7-MCLv4`, and upstream `0.7.8` starts at `0.7.8-MCLv1`.

Commit snapshots use `MCLvN-MMDD`, where the month and day come from the UTC timestamp of the exact upstream commit. The revision increases with each upstream or adaptation update and continues across years, so `MCLv9-1231` can advance to `MCLv10-0125`. The full timestamp and exact commit stay in the source metadata.

Components maintained in this repository use their own versions. Packages of upstream publisher binaries also use the MCL suffix for the packaging revision, and the embedded vendor version stays unchanged. `lib/package-version.mjs` implements both revision calculations.

### Changing a package version

`tools/reversion-runtime.mjs` changes the version in the package's file list and in the runtime manifest by rewriting the archive as a stream. All other file bytes, modes, source checksums, native signatures and dependency records stay the same. The tool takes `--archive`, `--record`, `--version` and a new `--output` path, and the original archive stays unchanged. It does not compile anything. The rewritten package gets a new version and checksum; a published package is never changed.

### Catalog contents

A project's catalog keeps every published package and gains at most one new version in each publication. Unpublished candidates that a newer one replaced are left out of the records, the producer outputs and the source history. HashLink 1.9 and 1.12, and Steamworks4j 1.9 and 1.10, have separate packages because their game ABIs are incompatible.

## Draft upload and publication

`stage` uploads a prepared package to GitHub through an authenticated GitHub CLI. Before it creates the draft release, it validates the local package and creates the source tag at the exact `--target` commit; an existing tag, including an annotated tag, must resolve to that same commit, and a conflicting tag is never replaced. The runtime archive is the only public attachment, and the release notes contain a collapsed Source section that links to the tagged source and the upstream commits. Existing releases and assets are not replaced.

```sh
node tools/release-runtime.mjs stage --bundle out/gemrb-release \
  --target <40-character-builds-source-commit>
```

A manual GitHub Actions workflow, **Runtime release**, takes a project, version and architecture. It checks out the source commit of the selected tag, downloads only that draft's binary archive and validates it against the catalog at that commit. Its `stage` operation creates a draft from a successful build artifact, `verify` keeps an existing draft, and `publish` publishes the same bytes; none builds native code. The repository's **Source** workflow runs on pushes to `main`, on pull requests and when started by hand; creating a runtime tag does not start it.

Packages built by **Runtime build** are not in the catalog yet. For them, the `build-run` input of **Runtime release** names the ID of the build run. Staging requires that input and a dispatch from `main`; the workflow selects its source commit before creating the tag. The job first confirms that the run is complete and that the selected project, version and architecture have a successful package job. Each package is checked independently. It then downloads the run's artifact for the selected architecture, checks it with `verify`, verifies its GitHub attestation against the build workflow and source commit, and compares it with the draft's asset through `verify-remote` before `publish`. A draft staged locally from the artifact of a push-triggered run, with `stage --target` set to that run's commit, is published the same way without a second build. Each architecture needs its own dispatch. `verify-remote --bundle <directory>` can also be run locally; it reads the release from GitHub and changes nothing.

After publication, the same artifact updates the catalog:

```sh
gh run download <run-id> --repo procrastinine/maclauncher-builds \
  --name runtime-sys3-decompiler-0.5.0-MCLv1-x64 --dir out/sys3-decompiler-x64
node tools/release-runtime.mjs apply --bundle out/sys3-decompiler-x64
```

`apply --bundle <directory>` updates the local project catalog and regenerates `catalogs/index.json`. It makes no network request, commit or publication, and it cannot replace an existing package. Retiring a catalog entry is a separate, deliberate change, made together with the removal of the corresponding release. MacLauncher reads the per-project catalogs directly from Git, and the package index uses the same committed records.

### Helper packages

`tools/repackage-helpers.mjs` repackages a helper from a finished build and its declaration into a new output directory. The new package keeps the native binaries, the helper metadata that MacLauncher reads and the license notices. The matching source and build recipes are in the release commit.

When a publication leaves out build-only files, the recorded source stays the same: the declaration uses `sourceRelative: null` and keeps the original catalog source checksum. Native protocols, architectures and macOS requirements are preserved.

## Package browser

The [package index](https://procrastinine.github.io/maclauncher-builds/), a GitHub Pages site, lists the committed catalogs with their download links, architectures, minimum macOS versions, source tags and archive checksums. Each package is labeled Apple Silicon, Intel or Universal. Downloadable runtimes and tools are listed apart from bundled components, which are built into the MacLauncher app. Search filters the selected group, and project and ABI links open their matching group automatically.

The `index.json` next to the page contains the same records, explicit page URLs and each project's `delivery` value (`downloadable` or `bundled`). Every release entry there has its `arch` and its `launcherArchitectures`. Project links use `#<project-id>`. Incompatible ABI profiles also have stable anchors, including `#hashlink-1-9`, `#hashlink-1-12`, `#java-steamworks-1-9` and `#java-steamworks-1-10`.

`npm run index:build` generates `index.html`, `index.json`, `verification.html` and `verification.json` without compiling or downloading runtimes. A second workflow, **Package index**, regenerates and deploys the site when the catalogs, either project registry or the index inputs change on `main`. Preparing and publishing an individual runtime stay separate from that workflow.
