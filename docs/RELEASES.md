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

Both commands accept `--releases "project=version,other=version"` and optional `--output plan.json`. Output paths must be new. Component and pair ordering follows the resolved selection. Duplicate pairs and overlapping revisions of one ABI line are rejected before any dispatch. Distinct ABI versions of one project stay in the same component. If submission fails partway through, the error lists the components already submitted; successful submissions are not repeated automatically.

Each component retains the existing source, input verification, sealing, attestation and immutable-release checks. Read-only build jobs produce attested artifacts. Each component level has a separate publisher on a fresh checkout, holding the write token only there. Competing catalog pushes reapply only their own entry to fresh main with bounded retries; compilations remain parallel. No artifact crosses component runs. A single component produces one ordinary workflow dispatch.

The workflow UI also accepts its `releases` input directly, with pairs separated by commas or newlines:

```text
system3=1.8.0-MCLv3
android-launcher=1.0.1
```

Names are used as supplied. A name already published for the project cannot be reused. The workflow registers the selected names itself; source changes do not require hand-written version registrations. A matching ABI version line retains its declared inputs and CPUs. Other names use the project's default build profile.

One matrix builds the selected packages on their declared GitHub-hosted Mac or Linux runners. Each package is sealed, packed and attested with the shared build and packaging commands. Independent components run in parallel. Within a component, GitHub matrix dependency levels wait for earlier levels of that component; unrelated components never share this wait. A failed package does not discard another package's published output.

Recipes report their source pins, recipe files and consumed packages. Matching published input definitions reuse the exact attested release. Changed inputs build first in the same run; their verified artifacts pass directly to consumers on GitHub. Independent projects build in parallel with that chain. Automatically named inputs use the next published plain patch version for owned source, or the next project-wide MCL revision for an upstream build. An upstream recipe records its product version in `producer.upstreamVersion`; `null` identifies an unversioned product. Owned products first replace an old MCL label with a plain version; later releases increment its patch number. Snapshot names omit dates and hashes. The plan summary lists those names before any build starts.

Each archive seals `build-definition.json` and `build-inputs.json` in its regular file inventory. The latter lists the digest, release and source build of every resolved input. The ordinary archive attestation covers those records.

After a build level finishes, its clean publisher verifies each successful archive's signed provenance, publishes that package's release and appends its catalog entry. Other component levels can still be building. Packages whose required inputs have not published are skipped without discarding the other releases. A catalog entry is written only after the exact release asset is public. Competing catalog commits restart from fresh main and reapply that package's entry, with up to ten attempts and randomized backoff. An identical entry is a no-op. No force push or textual merge of shared JSON is used. If the catalog append fails, re-running that publish job reuses its retained attested bundle and existing release without compiling again. An existing release can resume only under its original run id; another run cannot replace it. Each archive has one immutable project/version/CPU identity. The index and Pages update from main after the component publishers finish. Their queued index updates do not cancel other component runs. No archive passes through a local computer for publication.

Each release and package-index row links the exact Builds source commit and build run. The downloaded archive can be checked with:

```sh
gh attestation verify <asset> --repo procrastinine/maclauncher-builds --signer-workflow procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml --deny-self-hosted-runners
```

The result identifies the source commit. It can be compared with the linked commit on GitHub. The signer workflow path is unchanged for historical and new packages.

The archive is the release attachment. Catalogs retain its SHA-256, architecture, supported launcher architectures and minimum macOS. Complete verified declarations are recorded at `catalogs/declarations/<project>/<version>/<arch>.json`; signed build records are in `attestations/`. Older published identities remain readable in catalog history and existing installations.

Recipes declare their exact public inputs and tool requirements. Changing recipe code does not rebuild an existing package. **Rebuild and compare** reproduces a published package at its recorded source commit and reports differences; it does not publish packages or change catalogs.

Each component run records per-job elapsed time in its summary. Source and packaging changes can be checked locally without repeating unchanged compilation. Builds used for releases run on GitHub.
