# Verifying MacLauncher Builds

This guide explains how every package in MacLauncher Builds is made and how anyone can check it. MacLauncher Builds provides the game engines, players and helpers that [MacLauncher](https://github.com/procrastinine/maclauncher) uses, and most of them are compiled here from public recipes. A recipe holds the build instructions, patches and exact source references for one package. The [Runtime build workflow](.github/workflows/runtime-build.yml) carries out those instructions on machines that GitHub runs (Mac or Linux), never on machines that the repository's owner controls. For each archive it produces, GitHub signs a build record, called an attestation, that ties the archive's SHA-256 to the recipe commit and the build run. Anyone with a Mac can also rebuild a package and compare the result.

## Two kinds of packages

Every package in the generated catalog and the [download index](https://procrastinine.github.io/maclauncher-builds/) is checked in one of two ways, and the publishing tools accept a package only when the check that applies to it has passed:

- A compiled or adapted package needs a build record from `runtime-build.yml`, signed on a GitHub-hosted runner for its exact archive bytes.
- A package of unchanged publisher files contains a publisher's files exactly as the publisher released them. It needs a complete file-by-file comparison with the publisher's original download, as described in [Verify an unchanged publisher package](#verify-an-unchanged-publisher-package).

A recipe on its own, a label that marks a package as prebuilt, or a build of something else counts for neither.

The [verification table](https://procrastinine.github.io/maclauncher-builds/verification.html) shows the evidence for every package. Each CPU build has its own row, with its minimum macOS version, recipe commit, build run, build record and the result of any recorded rebuild. The minimum macOS version is the one recorded for the complete package, which can differ from the SDK used to compile it. [App feature requirements](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) describe which MacLauncher features each Mac can run.

Some older archives in the catalog were built on a local machine and have neither kind of check. The table lists them separately at the top, under **Built locally — no GitHub build record yet**, with a count of those archives, and their status reads superseded, built locally. Installed copies of them keep working. GitHub builds that have passed their checks but are not yet in the catalog appear in a section of their own, with their exact versions and hashes; they never change how an older local archive is identified.

## Verify a compiled package

1. Choose a package in the [package index](https://procrastinine.github.io/maclauncher-builds/) and download its archive from its release. The package's catalog records the archive's file name and SHA-256. The GitHub CLI, `gh`, can download one exact archive:

   ```sh
   gh release download '<project>/v<version>/<arch>' \
     --repo procrastinine/maclauncher-builds \
     --pattern '<project>-<version>-<arch>.tar.gz'
   ```

2. Check the archive's build record. Set `RECIPE_COMMIT` to the full commit of this repository that the verification table shows, or to the commit that the release tag points to. An engine's own upstream commit is a different value and does not work here. Then run:

   ```sh
   gh attestation verify '<project>-<version>-<arch>.tar.gz' \
     --repo procrastinine/maclauncher-builds \
     --signer-workflow procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml \
     --source-digest "$RECIPE_COMMIT" \
     --deny-self-hosted-runners
   ```

   A successful check confirms that these exact bytes were built by the named workflow from that commit on a GitHub-hosted runner; `--deny-self-hosted-runners` rejects builds on machines that the repository owner supplies. Without a build record, nothing confirms that history. Some older packages have none, and their release tag and the SHA-256 in their catalog still identify them.

3. Optionally, rebuild the package on a Mac and compare. A rebuild needs Node 24.15 or newer, Git, the GitHub CLI, Xcode and Homebrew, and recipes written in Rust also need rustup. Clone this repository, then run:

   ```sh
   npm ci --ignore-scripts
   node tools/rebuild-runtime.mjs --project '<project>' \
     --version '<version>' --arch '<arch>' --install-tools true \
     --output /absolute/path/to/new-comparison
   ```

   The script downloads the published archive and checks it, finds the recipe commit that built it and runs that commit's build commands. `--install-tools true` lets it install the Homebrew and Rust tools that the recipe lists. Its report either confirms that the archives match or lists the files and metadata that differ, along with the build tools it found. The [Rebuild and compare workflow](.github/workflows/runtime-rebuild.yml), started by hand, runs the same command on a GitHub-hosted Mac. Neither one publishes a package. An older recipe without a build command that the script knows has manual instructions in its tagged source.

## Verify an unchanged publisher package

A package of unchanged publisher files is registered together with a description of the publisher's original download and that download's exact checksum. Its equality record lists every file of the publisher's application with the file's SHA-256, size and permissions (mode), and the package must match that list exactly. Besides those files, the package can add only a limited amount of metadata that MacLauncher reads, and license notices; it cannot add program code. Marking the package's producer as prebuilt is not enough to qualify. Generated metadata marks this kind of package with `authorityPolicy: "supplied-publisher"`, and compiled packages with `github-build`.

The verification table lists these packages separately, with the publisher's version, the number of files, the list of the publisher's files and the equality record. They have no GitHub build record. A passing comparison proves that the files are unchanged from the publisher's download, but it does not prove who the publisher is. An ad hoc code signature is not a Developer ID signature and does not identify the publisher either.

To check a downloaded archive against its equality record without changing any file, run:

```sh
node tools/publisher-files.mjs verify --project '<project>' \
  --archive /absolute/path/to/package.tar.gz --record /absolute/path/to/package-record.json
```

The equality record that the table links holds the package record in its `record` field. Adding `--input-archive /absolute/path/to/supplied-input.tar.gz` also checks the publisher's original archive again. Neither check depends on a GitHub build record.

## What a rebuild shows

Matching archive hashes mean that the rebuild produced exactly the same bytes. When the archives differ but the files inside them match, only the packing differs, such as the compression. A different compiler, macOS SDK, library or code signature can change the programs themselves. The report lists every difference it finds and the build tools that were used, and it never counts a package as matching because a file name matches or a build succeeded.

A build record and a rebuild answer different questions. The build record links an archive to the recipe and build run that produced it, while a rebuild compares a second build with that archive. Neither one reviews every line of upstream source code, and neither guarantees that the software is free of security flaws.

## Files from other publishers

MacLauncher also uses finished programs from their publishers. No recipe here compiles them, so a rebuild cannot reproduce them. When a package contains such a file, its build record covers how the package was put together, not how the publisher built the file. These files are checked in other ways. Several rely on a Developer ID signature, the code signature that Apple issues for software distributed outside the App Store; its team ID identifies the company that signed it.

| Component | How it is checked |
| --- | --- |
| Valve SteamCMD | Valve's Developer ID signature, team `MXGJJ98X76`. Steam checks its own updates and the content it downloads for a signed-in account. |
| YoYo Games Igor | YoYo Games' Developer ID signature, team `C9E7J7HL3D`. |
| Official YoYo Games runners | YoYo Games' HTTPS feeds list the address, size and signature details of each file. MacLauncher records the SHA-256 of each download to check the files later; that hash comes from MacLauncher, not from YoYo Games. |
| NVIDIA libraries and model files | NVIDIA's release digests when it publishes them, plus hashes recorded for each archive or for each file taken from it. NVIDIA's source is private, so these files cannot be rebuilt. |
| Other runtimes and tools from their publishers | The publisher's digest or signature when one is available. Otherwise an HTTPS download from the publisher, a check of the file format and a SHA-256 recorded at installation identify the installed copy. |

## Checking every package at once

The repository's tools need Node 24.15 or newer and the dependencies fixed in its lock file. After cloning this repository, these commands print the same list of packages and checks that the verification table is built from:

```sh
npm ci --ignore-scripts
node tools/package-index.mjs --local-builds
```

The JSON output lists:

- each locally built archive in the catalog, with its exact hash;
- active projects that still lack the check they need;
- projects of unchanged publisher files, with their comparisons;
- retired projects;
- signed GitHub builds that are not yet published.

Archives and projects are counted separately, because one project can have several versions and CPU builds, and a signed build can count for its project before that build is published. A locally built package that contains a publisher's program counts as built where the package was put together, which is locally; the publisher's program itself is checked as described in [Files from other publishers](#files-from-other-publishers).

Only active projects count toward coverage. A compiled project is covered when the newest packaging revision of each maintained version line has a verified build for each CPU. Older revisions stay in history. A universal archive covers both CPUs; a newer native package supersedes its earlier revision for that CPU. The report lists missing current version and CPU pairs. `projectsWithoutAuthority` lists the projects that still lack a GitHub build or a file comparison, and registering a project of unchanged publisher files does not take it off that list until its comparison passes. The summary keeps the total, active and retired counts apart, including the projects that need GitHub builds, the registered projects of unchanged publisher files and the unchanged packages that passed their comparison. The count of local archives includes older packages of retired projects. Retiring a project never turns one of its local archives into a verified GitHub build.

### How build records are checked

The tools check build records with [Sigstore](https://www.sigstore.dev/), the public signing service behind GitHub's build records. They trust only the copy of Sigstore's public trust information kept in `attestations/trusted-root.jsonl`, which was itself checked through Sigstore's secure update system, TUF. A package record cannot choose which trust information applies. That copy changes only through Sigstore's normal TUF update, the same one that `gh attestation trusted-root` uses; generating catalogs or importing an archive never replaces it.

To add the signed build record of an existing Runtime build output without publishing a catalog or a release, run:

```sh
node tools/record-github-build.mjs --release-bundle /absolute/path/to/runtime-build-output
```

The importer checks the actual archive, the package contents and the signed build record. `--bundle /absolute/path/to/signed-bundle.json` can supply a downloaded build record instead of fetching it through the GitHub CLI. The archive itself stays unchanged.

## Retired projects

A project is retired when a newer project replaces it. Its registry record then has a `supersededBy` field naming its immediate successor, and a project without that field is active. A retired project stays in the registry and in the verification history, but its packages leave the active downloads and it no longer counts toward build coverage. Its older versions, archive hashes, source references and signed build records keep their original project ID, and installed copies keep working.

Generated project metadata records `state` as `active` or `retired`, and archive rows carry `projectState`. The generated pages link to the successor and, when a project was replaced in several steps, also to the active project at the end of that chain. A successor must be a registered project, and a chain of successors cannot loop back on itself. These links never rename an archive, rewrite its build record or switch an installed runtime to another project.

Every project has a fixed link to its verification history, `#project-<project-id>`. Retired projects stay listed, with links to that history, in the download index and in the `--local-builds` output. Their locally built packages still appear at the top of the verification table under **Built locally — no GitHub build record yet**, and their signed builds stay visible as retired history.

[Verifying MacLauncher](https://github.com/procrastinine/maclauncher/blob/master/docs/development/VERIFYING.md) describes how the app itself is built and checked, including the packages from this repository that ship inside it. [Runtime releases](docs/RELEASES.md) explains package names, release tags and publication.
