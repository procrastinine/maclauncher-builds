# Source pins

Project upstream descriptions reference the pin consumed by the selected
producer. A reference contains a relative file and a JSON pointer:

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

The selected value can be a 40-character commit string or a source object with
`revision` or `commit`, an optional repository, version and commit timestamp.
`repositoryPointer` selects an origin from the same file when the commit is a
scalar. An origin supplied by the producer must match the registered origin;
terminal `.git` suffixes are equivalent. A referenced upstream cannot also
supply `revision`, `version` or `committedAt` overrides.

Owned CommonJS producers can expose their existing build constant directly:
`{"file":"producers/maclauncher/src/modules/ai5/runtime/portable-build-v4.js","pointer":"/REVISION"}`.
Resolution loads the same trusted owned module as the producer and reads its
export without calling build functions. JSON metadata is preferred for new
producers. Export references preserve existing recipe and package identities.

Named entries preserve held releases when an array is reordered:

```json
{
  "file": "producers/maclauncher/src/modules/hashlink/runtime/manager.js",
  "pointer": "/core/catalog",
  "match": {"version": "1.16"},
  "field": "/upstreamRevision"
}
```

`match` requires exactly one entry. Missing or ambiguous selections fail.
Different ABI or supplier profiles retain separate references, including ART's
held AIM supplier and the common Android native-memory implementation. Updating
one profile does not advance another profile's pin.

`lib/projects.mjs` resolves upstreams for update comparisons, source builds and
release notes. Resolved upstreams retain the flat revision API without retaining
the reference, so resolved registry snapshots remain self-contained.
References have no copied-revision, Git-HEAD, network or cache fallback. Each
registry resolution reads one consistent set of metadata; subsequent reads pick
up changes to the authoritative files.

Catalog indexing and sealed release preparation/verification use
`resolvePins:false`. These operations validate reference syntax without loading
producer modules or requiring source submodules. Update checks and source builds
resolve their selected pins. Android metadata resolution needs only the
`sources/maclauncher-android` submodule; initializing its nested AOSP checkouts
is unnecessary for metadata. The source workflow initializes that top-level
checkout. Package-index publication watches declared pin inputs.

Split project registries require references for every upstream. Inline revisions
are accepted only in self-contained resolved flat registry snapshots. Reference
selection and producer pins remain independent of update discovery.
