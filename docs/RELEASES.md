# Runtime releases

Every runtime project has independent versions, tags and binary downloads.
Preparing or releasing one runtime does not build other runtimes. Existing
compatible sealed outputs and publisher binaries remain package inputs;
compilation is a separate operation through the registered producer. Producer
entries use the `sourceDirectory` in the [project registries](PACKAGES.md#projects-and-packages): owned launcher adaptations
live under `producers/maclauncher`, and Android uses `sources/maclauncher-android`.

## Local preparation

`tools/release-runtime.mjs prepare` runs offline. It accepts a sealed supplemental
declaration or a manager output containing `manifest.json` and `files/`.
The adapter preserves runtime contents, native CPU identities and file modes.

```sh
node tools/release-runtime.mjs prepare --project gemrb \
  --input /absolute/path/to/sealed-manager-output \
  --output out/gemrb-release

node tools/release-runtime.mjs prepare --project android \
  --input /absolute/path/to/sealed-runtime \
  --declaration /absolute/path/to/declaration.json \
  --output out/android-release
```

An existing package can be reused through `--archive` and `--record`, without
recompression. Declaration arrays are selected by the explicit project ID.
Output directories contain the runtime archive, its existing package-record
sidecar and a project catalog snapshot. Separate source archives may be retained
locally through `--source` for package validation; they are not attached to a
binary-only release.

`verify --bundle <directory>` checks the archive and sidecar against the complete
sealed inventory without executing runtime contents. Project, version and
architecture can be checked explicitly with the corresponding options.

## Source and release identity

Tags use `<project>/v<version>/<arch>` and identify the corresponding Builds
commit. That commit contains the matching source, owned patches,
build recipes and pinned dependency definitions. Submodule source is available
through recursive Git checkout; GitHub's automatic source ZIPs omit it.

The archive checksum and size remain in `catalogs/<project>.json`. Archived
source checksums remain provenance and do not require uploading duplicate source
archives. The corresponding source is supplied through the tagged repository.

Package identities use one naming rule: tag `<project>/v<version>/<arch>`,
archive `<project>-<version>-<arch>.tar.gz`. The package inventory and consumed
runtime manifest contain that exact version. Architecture appears only in the
final `arm64`, `x64` or `universal` component.

Tagged upstream versions use `<upstream-version>-MCLvN`. The MacLauncher revision
starts at 1 for each upstream version: `0.7.7-MCLv3` advances to
`0.7.7-MCLv4` for an adaptation change, while upstream `0.7.8` starts at
`0.7.8-MCLv1`. Commit snapshots use `MCLvN-MMDD`, with the month/day from the
exact upstream commit's UTC timestamp. Their revision increases for each upstream
or adaptation update across years: `MCLv9-1231` can advance to `MCLv10-0125`.
Full timestamps and exact commits remain in source metadata. Owned components
use their own version. Upstream publisher packages also use the MCL suffix for
the packaging revision; embedded vendor versions remain unchanged.
`lib/package-version.mjs` supplies both revision calculations.

`tools/reversion-runtime.mjs` updates the package inventory and consumed manifest
through a streaming archive rewrite. It retains all other file bytes, modes,
source checksums, native signatures and dependency identities. It accepts
`--archive`, `--record`, `--version` and a new `--output` path; the original
archive remains unchanged. Compilation is a separate producer operation. New
package bytes receive a new version and checksum; published identities remain
immutable.

The catalog retains published packages and at most one new version per project per publication. Superseded unpublished candidates are omitted from records, producer outputs and source history. Separate HashLink 1.9/1.12 and Steamworks4j 1.9/1.10 packages preserve incompatible game ABIs. MKXP-Z publisher updates use the upstream provider;
the Builds catalog contains the Apple Silicon Unicode filename normalization
adaptation.

## Draft upload and publication

`stage` is an explicit network command using authenticated GitHub CLI access.
It validates the local package and creates the source tag at the exact
`--target` commit before creating the draft. An existing tag must resolve to that
same commit, including annotated tags; conflicting tags are never replaced.
The only public attachment is the runtime archive.
The release notes contain a collapsed Source section linking to the tagged
source and upstream revisions. Existing releases and assets are not replaced.

```sh
node tools/release-runtime.mjs stage --bundle out/gemrb-release \
  --target <40-character-builds-source-commit>
```

The manual **Runtime release** workflow accepts a project, version and
architecture. It checks out the selected tag's source commit, downloads only that
draft's binary archive and validates it against the catalog at that commit. The
`verify` operation retains the draft; `publish` publishes those same existing
bytes. Neither operation builds native code. Source CI runs for pushes to
`main`, pull requests and manual dispatch; runtime tag creation does not run it.

`apply --bundle <directory>` updates the local project catalog and regenerates
`catalogs/index.json`. Existing package identities cannot be replaced. Catalog retirement is a separate,
deliberate change applied together with the corresponding release removal.
It performs no network request, commit or publication. MacLauncher reads per-project Git catalogs directly; the Pages browser uses the
same committed catalog records.

Helper package projections use `tools/repackage-helpers.mjs` with a sealed input, its declaration and a fresh output directory. The resulting content version retains native images, consumed helper metadata and license notices. Source checksums remain provenance; the matching owned source and build recipes remain in the release commit. Existing source identities remain unchanged when a publication omits build-only files. Such declarations use `sourceRelative: null` and retain the original catalog source checksum. Native protocols, architectures and macOS requirements are preserved.

## Package browser

[The package index](https://procrastinine.github.io/maclauncher-builds/) lists the
committed catalogs, download links, architectures, minimum macOS versions, source
tags and archive checksums. Downloadable runtimes and tools appear separately
from included components. Included components ship with MacLauncher for offline
use and require no separate installation or setup. Search filters the selected
group. Project and ABI links open their matching group automatically.

Its adjacent `index.json` exposes the same records, explicit page URLs and each
project's `delivery` classification (`downloadable` or `bundled`).
Project links use `#<project-id>`; incompatible ABI profiles also have stable
anchors, including `#hashlink-1-9`, `#hashlink-1-12`,
`#java-steamworks-1-9` and `#java-steamworks-1-10`.
`npm run index:build` generates both files without compiling or downloading
runtimes. The **Package index** workflow regenerates and deploys the site when
catalogs, either project registry or index inputs change on `main`. Individual runtime preparation and
publication remain independent operations.
