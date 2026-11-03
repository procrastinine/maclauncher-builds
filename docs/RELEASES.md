# Runtime releases

The **Build and release** workflow in [runtime-build.yml](../.github/workflows/runtime-build.yml) builds and publishes selected projects. Source pushes run Source checks. They do not compile or publish runtimes.

## Start a release

`tools/dispatch-release.mjs` starts one **Build and release** run per connected component of the selected packages and rebuilt inputs. A graphics chain waits only for the graphics component's build levels. Packages connected through a shared rebuilt input stay in the same run. Published inputs remain ordinary exact verified dependencies.

A text file contains project and release-name pairs, separated by commas or newlines. The local preview reads recipes and catalogs without changing registrations or contacting GitHub:

```sh
node tools/dispatch-release.mjs plan --file releases.txt
```

The explicit dispatch command checks current GitHub release names, validates all registrations without writing them locally, and submits each component's exact pairs to the existing workflow on `main`:

```sh
node tools/dispatch-release.mjs dispatch --file releases.txt
```

Both commands accept `--releases "project=version,other=version"` and optional `--output plan.json`. Output paths must be new. Components containing graphics, Android/native builds and mpv dispatch first, in that order; other components retain selection order. Pair order within each component is unchanged. Duplicate pairs and overlapping revisions of one ABI line are rejected before any dispatch. Distinct ABI versions of one project stay in the same component. If submission fails partway through, the error lists the components already submitted; successful submissions are not repeated automatically.

Each component retains the existing source, input verification, sealing, attestation and immutable-release checks. Read-only build jobs produce attested artifacts. Each component level has a separate publisher on a fresh checkout, holding the write token only there. Publish jobs share one cross-run publication queue and process their packages sequentially; compilations remain parallel. No artifact crosses component runs. A single component produces one ordinary workflow dispatch.

The workflow UI also accepts its `releases` input directly, with pairs separated by commas or newlines:

```text
system3=1.8.0-MCLv3
android-launcher=1.0.1
```

Names are used as supplied. A name already published for the project cannot be reused. The workflow registers the selected names itself; source changes do not require hand-written version registrations. A matching ABI version line retains its declared inputs and CPUs. Other names use the project's default build profile.

One matrix builds the selected packages on their declared GitHub-hosted Mac or Linux runners. Each package is sealed, packed and attested with the shared build and packaging commands. Independent components run in parallel. Within a component, GitHub matrix dependency levels wait for earlier levels of that component; unrelated components never share this wait. A failed package does not discard another package's published output.

Recipes report their source pins, recipe files and consumed packages. Matching published input definitions reuse the exact attested release. Changed inputs build first in the same run; their verified artifacts pass directly to consumers on GitHub. Independent projects build in parallel with that chain. Automatically named inputs use the next published plain patch version for owned source, or the next project-wide MCL revision for an upstream build. An upstream recipe records its product version in `producer.upstreamVersion`; `null` identifies an unversioned product. Owned products first replace an old MCL label with a plain version; later releases increment its patch number. Snapshot names omit dates and hashes. The plan summary lists those names before any build starts.

Each archive seals `build-definition.json` and `build-inputs.json` in its regular file inventory. The latter lists the digest, release and source build of every resolved input. The ordinary archive attestation covers those records.

After a build level finishes, its clean publisher downloads each retained artifact and verifies its archive, sealed record and attestation against the original source commit and run ID. Job-list metadata is not used as proof of build success. Every input named in the sealed build-input report must already have a public release with its exact recorded archive digest before the consumer is staged. An input selected in this run that is not public skips its consumer with a notice pointing to that input's publication job. A selected build with no retained package artifact is also skipped with a notice pointing to its build job. Unexplained missing inputs, different public digests and transport errors remain failures. All publishers use the same cross-run queue with `queue: max` and `cancel-in-progress: false`. Each job handles one package at a time.

For each package, the publisher checks the exact public release tag. An existing public release must contain the same single archive and digest. Otherwise it creates a draft through REST with the release name and exact source commit, uploads to the returned release ID, checks the returned size and digest, then makes that ID public. The publisher never creates tag refs separately. A failed unpublished attempt deletes its own draft; an unfinished draft for that exact name is removed before another attempt. Failed builds leave no published name or registration, so an unpublished name remains available when source changes.

The public release precedes its catalog entry. Cataloging fetches main, applies only that entry, commits and pushes normally. An identical entry is a no-op. Any rejected push restarts from fresh main and reapplies the entry, with at most ten attempts. No textual merge of shared JSON, force push, visibility polling or timing wait is used. A failure after release publication leaves the immutable archive in place; recovery repeats this same path and appends the missing catalog entry. The index and Pages update from main after the component publishers finish. Their queued index updates do not cancel other component runs. No archive passes through a local computer for publication.

## Resume publication without rebuilding

When only publication failed, use GitHub's **Re-run failed jobs** on the original run within 30 days. The publisher checks out the current main branch while retaining the run's original selection, source commit and attested artifacts. The package-definition reports remain available for the same 30-day recovery window. After that window, rebuild from main.

Publication results and Pages artifacts have per-attempt names. Pages uploads and deployment use the same name, so an earlier upload cannot conflict with the next deployment.

Each release and package-index row links the exact Builds source commit and build run. The downloaded archive can be checked with:

```sh
gh attestation verify <asset> --repo procrastinine/maclauncher-builds --signer-workflow procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml --deny-self-hosted-runners
```

The result identifies the source commit. It can be compared with the linked commit on GitHub. The signer workflow path is unchanged for historical and new packages.

The archive is the release attachment. Catalogs retain its SHA-256, architecture, supported launcher architectures and minimum macOS. Complete verified declarations are recorded at `catalogs/declarations/<project>/<version>/<arch>.json`; signed build records are in `attestations/`. Older published identities remain readable in catalog history and existing installations.

Recipes declare their exact public inputs and tool requirements. Changing recipe code does not rebuild an existing package. **Rebuild and compare** reproduces a published package at its recorded source commit and reports differences; it does not publish packages or change catalogs.

Each component run records per-job elapsed time in its summary. Source and packaging changes can be checked locally without repeating unchanged compilation. Builds used for releases run on GitHub.

Runtime packages are self-contained. Prepared packages supply build inputs only; matching bytes are retained inside each consumer rather than becoming runtime downloads. Identical files within one payload still use local canonical aliases. The sealed build-input record retains the digest and release of each input for provenance.
