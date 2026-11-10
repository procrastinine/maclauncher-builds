# Upstream commit references

A project record lists the upstream repositories that the project is built from, but it does not store their exact commits. Each upstream instead has a `pin`, a reference to the place where the project's producer records the commit it builds: a file in this repository and a [JSON pointer](https://www.rfc-editor.org/rfc/rfc6901) into that file. The producer's file is therefore the only place where the commit is recorded, and builds, update checks and release notes all read it from there. Every upstream in the project registries needs such a reference.

```json
{
  "id": "anyps5",
  "provider": "github",
  "url": "https://github.com/boykopovar/AnyPS5",
  "repository": "boykopovar/AnyPS5",
  "pin": {
    "file": "producers/anyps5/source.json",
    "pointer": "/source"
  }
}
```

The value at the pointer is either a 40-character commit string or a source object with `revision` or `commit` and, optionally, a repository, version and commit timestamp. When the value is a plain commit string, `repositoryPointer` selects the repository URL from the same file. A repository URL supplied by the producer must match the registered one, and a trailing `.git` makes no difference. An upstream that uses a reference cannot also set `revision`, `version` or `committedAt` directly.

## Build constants in CommonJS producers

A reference can also point at a constant that a CommonJS producer in this repository already exports: `{"file":"producers/package-support/src/modules/ai5/runtime/portable-build-v4.js","pointer":"/REVISION"}`. Resolving it loads the same module that the producer uses and reads the export without calling any build function. New producers record their commits in JSON files instead; references to exports let existing recipes and packages stay unchanged.

## Entries in arrays

When the commit is inside an array, `match` selects the entry by its fields rather than its position, so reordering the array does not change which commit is used:

```json
{
  "file": "sources/maclauncher/src/modules/hashlink/runtime/manager.js",
  "pointer": "/core/catalog",
  "match": {"version": "1.16"},
  "field": "/upstreamRevision"
}
```

`match` must select exactly one entry; a missing or ambiguous match fails. Builds for different ABIs or suppliers have separate references even when they use the same upstream. For example, the ART adapter's AIM source and the common Android native-memory implementation each have their own reference, and updating one does not change the other's commit.

## Resolution

`lib/projects.mjs` resolves the references for update comparisons, source builds and release notes. A resolved upstream has a plain `revision` field in place of its reference, so a resolved copy of the registry is self-contained. A reference that cannot be read fails; it never falls back to a copied commit, Git HEAD, the network or a cache. Each resolution of the registry reads one consistent set of files, and later resolutions pick up changes to them.

Catalog indexing and the preparation and verification of finished releases use `resolvePins:false`. These operations check the syntax of each reference without loading producer modules or needing the source submodules. Update checks and source builds resolve the references they need. Resolving the Android references needs only the `sources/maclauncher-android` submodule, without its nested AOSP checkouts, and the source workflow initializes that submodule. The package-index workflow also runs when a file that a reference points to changes.

Commits written directly into an upstream entry are accepted only in resolved, self-contained copies of the registry. The update checker never changes a reference or the commit a producer records.

## HTTP build inputs

A build lists the archives it reads in its `archives` field. Each entry names a JSON file and a JSON pointer, and every archive record inside the selected value is a build input. An archive record is a source record with an archive digest (`repository`, `revision` and `archive.sha256`); a source record with the SHA-256 of its repository archive (`repository`, a 40-character `revision` or a `gitlink` whose recorded commit is the revision, and `sha256`, without `url` or `path`); a `url` with `sha256`, optional `bytes` or `size`, and `offset` for a byte range; a `url` with only `sha512`, when the publisher states only that digest, and optional `bytes` or `size`; `archiveUrl` with `archiveSha256` and optional `archiveBytes`, where `{revision}` in the URL is the record's `revision`; a file of a Gitiles repository (`repository`, a 40-character `revision` and `path`, with `transport` holding the `sha256` and optional `bytes` of its base64 `?format=TEXT` response); or a GitHub release asset (`repository`, `version`, `asset` and `sha256`). A row of a record's `files` list without its own `url` reads that record's `url`. An entry can instead name a lock file of shell-style `KEY=value` lines and, in `keys`, the variable holding the record's `url` and the one holding its `sha256` or `sha512`; each variable appears once in the file. An entry can also name one of the build's architectures; its archives are then read only by that architecture's build. The build definition lists each archive, with its architecture when only one architecture reads it. The input step downloads it once, before compilation, into the build-input cache, which names each file by its digest, and the recipe reads it from that cache.

[python-build-tools.json](../tools/python-build-tools.json) records the Python interpreter and the Python build tools for both macOS build platforms: one interpreter archive per platform, and the exact wheel of each tool with named tool sets. Builds that run Python list its `/interpreters` value, and builds that run the tools also list `/wheels`. The build installs the interpreter for its host with uv from the fetched archive, and installs a tool set into an isolated environment from the fetched wheels, without a package index or a network read.

Build-input downloads use one HTTP transport with up to six attempts and exponential backoff (5, 10, 20, 40 and 80 seconds). Connections have a 20-second timeout; transfers below 1 KB/s for 60 seconds are treated as stalled. Healthy transfers have no duration cap. Stalls, interrupted connections, HTTP 408/429 and server failures can retry. Other client errors, including HTTP 404, fail immediately. Source-object, archive-size and checksum verification follows the download and is never retried as a transport failure. HTTPS inputs remain on HTTPS across redirects.

Git source fetches and submodule initialization use the same transient-only policy as attestation, artifact transfers and release API requests.

Recipes add component licence texts to `licenses/`. Texts with the same bytes after whitespace is removed share one file; `licenses/components.txt` records each component’s file. Missing or unreadable sources produce a warning. Licence files are ordinary payload files: inventories, archive digests and attestations cover their bytes. Included package payloads keep their existing licence directories.
