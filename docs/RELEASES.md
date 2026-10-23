# Runtime releases

Every runtime project has independent versions, tags and binary downloads.
Preparing or releasing one runtime does not build other runtimes. Existing
compatible sealed outputs and publisher binaries remain package inputs;
compilation is a separate operation through the registered producer. Producer
entries use the `sourceDirectory` in `projects.json`: owned launcher adaptations
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
archive `<project>-<version>-<arch>.tar.gz`. The version is the producer's sealed
version string; catalog display labels do not rename binaries or archives.
Upstream release versions or exact source snapshots identify the base, and owned
adaptation revisions identify the Mac build. A payload change receives a new
version; existing tag, archive bytes and checksum remain immutable. Architecture
is expressed by the final `arm64`, `x64` or `universal` component.

The catalog lists the current working package for each runtime type. Separate
HashLink 1.9/1.12 and Steamworks4j 1.9/1.10 packages preserve incompatible game
ABIs. Superseded package generations are removed from the catalog and Releases;
source tags remain available. MKXP-Z publisher updates use the upstream provider;
the Builds catalog contains the patched Apple Silicon runtime.

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
tags and archive checksums. Its adjacent `index.json` exposes the same records.
`npm run index:build` generates both files without compiling or downloading
runtimes. The **Package index** workflow regenerates and deploys the site when
catalogs or index inputs change on `main`. Individual runtime preparation and
publication remain independent operations.
