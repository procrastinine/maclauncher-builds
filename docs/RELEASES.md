# Runtime releases

The **Build and release** workflow in [runtime-build.yml](../.github/workflows/runtime-build.yml) builds and publishes selected projects. Source pushes run Source checks. They do not compile or publish runtimes.

## Start a release

`tools/dispatch-release.mjs` starts one **Build and release** run per connected component of the selected packages and rebuilt inputs. A graphics chain waits only for the graphics component's build levels. Packages connected through a shared rebuilt input stay in the same run. Published inputs remain ordinary exact verified dependencies.

`releases.txt` holds the current package set, one `project=version` per line. Push changes to that file on `main` to start a release. [start-release.yml](../.github/workflows/start-release.yml) compares the pushed file with its previous Git version and dispatches only added or changed pairs, entirely on GitHub. Unchanged and removed lines start nothing; already-published changed pairs are skipped with a notice. Ordinary source and catalog commits do not start builds. The start summary lists every selected project, version and CPU by component, and every skipped pair with its reason.

A local preview reads recipes and catalogs without changing registrations or contacting GitHub:

```sh
node tools/dispatch-release.mjs plan --file releases.txt
```

The planner and hosted dispatcher accept `--releases "project=version,other=version"` and optional `--output plan.json`. Output paths must be new. Components containing graphics, Android/native builds and mpv dispatch first, in that order; other components retain selection order. Pair order within each component is unchanged. Duplicate pairs and overlapping revisions of one ABI line are rejected before any dispatch. Distinct ABI versions of one project stay in the same component. If submission fails partway through, the error lists the components already submitted; successful submissions are not repeated automatically.

Each component retains source, input-digest, sealing, attestation generation and immutable-release checks. Read-only build jobs produce artifacts. One attest job in runtime-build.yml signs every built file, so the signer workflow is always runtime-build.yml. One publisher on a fresh checkout holds the write token, only there. Publish jobs share one cross-run publication queue and process their packages sequentially; compilations remain parallel. No artifact crosses component runs. A single component produces one ordinary workflow dispatch.

The workflow UI also accepts its `releases` input directly, with pairs separated by commas or newlines:

```text
system3=1.8.0-MCLv3
android-launcher=1.0.1
```

The `publish` input, on by default, can be turned off to build and seal the selected packages without attesting or publishing them; such a run may rebuild a name that is already published, and it skips the publication checks, attest job, publisher and index.

Names are used as supplied. A name already published for the project cannot be reused. The workflow registers the selected names itself; source changes do not require hand-written version registrations. A matching ABI version line retains its declared inputs and CPUs. Other names use the project's default build profile.

One matrix builds the selected packages on their declared GitHub-hosted Mac or Linux runners. Each package is sealed and packed with the shared build and packaging commands. Independent components run in parallel. The plan orders the selected builds into dependency levels, as many as the recipes need, and [runtime-level.yml](../.github/workflows/runtime-level.yml) runs the builds of each level in turn; a level's builds read earlier levels' artifacts from the same run. Packages without unpublished inputs form the first level. After the last level, the attest job signs every built file and the publisher publishes complete packages in level order, so each input is public before its consumers. A failed package does not discard another package's published output.

Workflows and composite actions name no project, source or path. Every job prepares the sources its tools read through `tools/init-runtime-sources.mjs`: without arguments for the pinned app source, with `--metadata` for planning, with `--checks` for npm test (the planning sources and every source repository pinned directly under `sources/`), and with `--project` and `--version` for one build.

Before any build starts, the plan checks what publication needs, read-only: each target's identity, tag, asset name and declared release version; that each selected project's catalog parses; that the package index builds from the current catalogs; that no target tag or release name exists; that Pages builds from a workflow and its `github-pages` environment exists; and that the publishing, index and deploy jobs declare the token grants they need. Any failed condition stops the run with a list of every failure.

On macOS, a build command's search path holds the project's declared Homebrew formulae, Xcode's toolchain directory and the system directories. Declared formulae come ahead of the toolchain directory, so a declared Bison, Flex or M4 replaces the older copies there. A formula with its own `clang` comes after it, so builds keep Xcode's compiler.

Recipes report their source pins, recipe files and consumed packages. Only the requested lines build. Every other input with a public release is used as published, pinned by the archive digest of each architecture. An input without a public release builds first in the same run at the version its `releases.txt` line names, and its verified artifacts pass directly to consumers on GitHub. Independent projects build in parallel with that chain. The plan summary lists every input it builds, with its version, before any build starts.

The retained release bundle contains `build-definition.json` and `build-inputs.json` beside the archive and its package record. The latter lists the digest, release and source build of every resolved input. The build attests all bundle files; publication verifies the reports before using them. These provenance reports are not installed payload files, and packaging preserves the producer-sealed inventory.

Recipes add component licence texts to `licenses/`. Texts with the same bytes after whitespace is removed share one file; `licenses/components.txt` records each component’s file. Missing or unreadable sources produce a warning. Licence files are ordinary payload files: inventories, archive digests and attestations cover their bytes. Included package payloads keep their existing licence directories.

After the last build level, the publisher lists that run's artifacts once. A package version publishes only when every one of its architectures built: if any architecture has no artifact, every architecture of that version is skipped with a notice and no tag, release or catalog entry is written. Otherwise all architectures are downloaded and their archive SHA-256 values checked against the build jobs' sealed records before the first one is published. The publisher does not download or verify attestations; users and app CI verify them with GitHub's current trust material. Job-list metadata is not used as proof of build success. Every input named in the sealed build-input report must already have a public release with its exact recorded archive digest before the consumer is staged. An input selected in this run that is not public skips its consumer with a notice pointing to that input's publication job. A selected build with no retained package artifact is also skipped with a notice pointing to its build job. Unexplained missing inputs, different public digests and transport errors remain failures. All publishers use the same cross-run queue with `queue: max` and `cancel-in-progress: false`. Each job handles one package at a time.

For each package, the publisher checks the exact public release tag. An existing public release must contain the same single archive and digest. Otherwise it creates a draft through REST with the release name and exact source commit, uploads to the returned release ID, checks the returned size and digest, then makes that ID public. The publisher never creates tag refs separately. A failed unpublished attempt deletes its own draft; an unfinished draft for that exact name is removed before another attempt. Failed builds leave no published name or registration, so an unpublished name remains available when source changes.

The public release precedes its catalog entry. Cataloging fetches main, applies only that entry, commits and pushes normally. An identical entry is a no-op. Any rejected push restarts from fresh main and reapplies the entry, with at most ten attempts. No textual merge of shared JSON, force push, visibility polling or timing wait is used. A failure after release publication leaves the immutable archive in place; recovery repeats this same path and appends the missing catalog entry. Rerunning a failed publisher resumes the same path without rebuilding. The index and Pages update from main after the publisher finishes. The Pages deploy job reads the artifact named by its build job, so a deploy that times out can be rerun alone; [pages.yml](../.github/workflows/pages.yml) can also be dispatched by itself. Their queued index updates do not cancel other component runs. No archive passes through a local computer for publication.

## Resume publication without rebuilding

When only publication failed, use GitHub's **Re-run failed jobs** on the original run within 30 days. The publisher checks out the current main branch while retaining the run's original selection, source commit and attested artifacts. The package-definition reports remain available for the same 30-day recovery window. After that window, rebuild from main.

Publication results and Pages artifacts have per-attempt names. Pages uploads and deployment use the same name, so an earlier upload cannot conflict with the next deployment.

Each release and package-index row links the exact Builds source commit and build run. The downloaded archive can be checked with:

```sh
gh attestation verify <asset> --repo procrastinine/maclauncher-builds --signer-workflow procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml --deny-self-hosted-runners
```

The result identifies the source commit. It can be compared with the linked commit on GitHub. The signer workflow path is `runtime-build.yml`.

The archive is the release attachment. Catalogs retain its SHA-256, architecture, supported launcher architectures and minimum macOS. Complete verified declarations are recorded at `catalogs/declarations/<project>/<version>/<arch>.json`; attestations remain available from GitHub. A catalog keeps the record of every version published for its project.

Recipes declare their exact public inputs and tool requirements. Changing recipe code does not rebuild an existing package. **Rebuild and compare** reproduces a published package at its recorded source commit and reports differences; it does not publish packages or change catalogs.

Each component run records per-job elapsed time in its summary. Source and packaging changes can be checked locally without repeating unchanged compilation. Builds used for releases run on GitHub.

Runtime packages are self-contained. Prepared packages supply build inputs only; matching bytes are retained inside each consumer rather than becoming runtime downloads. Identical files within one payload still use local canonical aliases. The sealed build-input record retains the digest and release of each input for provenance.
