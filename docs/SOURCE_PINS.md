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

A reference can also point at a constant that a CommonJS producer in this repository already exports: `{"file":"producers/maclauncher/src/modules/ai5/runtime/portable-build-v4.js","pointer":"/REVISION"}`. Resolving it loads the same module that the producer uses and reads the export without calling any build function. New producers record their commits in JSON files instead; references to exports let existing recipes and packages stay unchanged.

## Entries in arrays

When the commit is inside an array, `match` selects the entry by its fields rather than its position, so reordering the array does not change which commit is used:

```json
{
  "file": "producers/maclauncher/src/modules/hashlink/runtime/manager.js",
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
