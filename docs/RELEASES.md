# Runtime releases

The **Build and release** workflow in [runtime-build.yml](../.github/workflows/runtime-build.yml) builds and publishes selected projects. Source pushes run Source checks. They do not compile or publish runtimes.

The workflow's `releases` input contains project and release-name pairs, separated by commas or newlines:

```text
system3=1.8.0-MCLv3
android-launcher=1.0.1
```

Names are used as supplied. A name already published for the project cannot be reused. The workflow registers the selected names itself; source changes do not require hand-written version registrations. A matching ABI version line retains its declared inputs and CPUs. Other names use the project's default build profile.

One matrix builds the selected packages on their declared GitHub-hosted Mac or Linux runners. Each package is sealed, packed and attested with the shared build and packaging commands. Independent jobs run in parallel. A failed package does not discard another package's successful output.

Recipes report their source pins, recipe files and consumed packages. Matching published input definitions reuse the exact attested release. Changed inputs build first in the same run; their verified artifacts pass directly to consumers on GitHub. Independent projects build in parallel with that chain. Automatically named inputs use the next published plain patch version for owned source, or the next project-wide MCL revision for an upstream build. Snapshot names omit dates and hashes. The plan summary lists those names before any build starts.

Each archive seals `build-definition.json` and `build-inputs.json` in its regular file inventory. The latter lists the digest, release and source build of every resolved input. The ordinary archive attestation covers those records.

The publication job reads this run's artifacts on GitHub, checks their signed provenance and sealed declarations, creates the releases and commits the registrations and catalogs. Each archive has one immutable project/version/CPU identity. The index and Pages update from that catalog commit. No archive passes through a local computer for publication.

Each release and package-index row links the exact Builds source commit and build run. The downloaded archive can be checked with:

```sh
gh attestation verify <asset> --repo procrastinine/maclauncher-builds --signer-workflow procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml --deny-self-hosted-runners
```

The result identifies the source commit. It can be compared with the linked commit on GitHub. The signer workflow path is unchanged for historical and new packages.

The archive is the release attachment. Catalogs retain its SHA-256, architecture, supported launcher architectures and minimum macOS. Complete verified declarations are recorded at `catalogs/declarations/<project>/<version>/<arch>.json`; signed build records are in `attestations/`. Older published identities remain readable in catalog history and existing installations.

Recipes declare their exact public inputs and tool requirements. Changing recipe code does not rebuild an existing package. **Rebuild and compare** reproduces a published package at its recorded source commit and reports differences; it does not publish packages or change catalogs.
