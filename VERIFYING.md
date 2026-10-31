# Verifying MacLauncher Builds

MacLauncher Builds provides public recipes for the game engines, players and helpers used by [MacLauncher](https://github.com/procrastinine/maclauncher). A recipe contains the build instructions, patches and exact source references for a package. The [Runtime build workflow](.github/workflows/runtime-build.yml) runs these instructions on GitHub-hosted Macs and signs a build record, called an attestation, that ties an archive's SHA-256 to its recipe commit and build run. Anyone with a Mac can also rebuild a package and compare the result.

The generated package catalog and [download index](https://procrastinine.github.io/maclauncher-builds/) use two verification routes. Compiled and adapted packages require an attestation from `runtime-build.yml` on a GitHub-hosted runner for their exact archive bytes. Registered unmodified publisher files require a complete file-equality proof against their declared supplied input. Publication tools require the applicable proof; a recipe, a prebuilt label or an unrelated build does not qualify.

The [verification table](https://procrastinine.github.io/maclauncher-builds/verification.html) keeps older catalog archives without either applicable proof separate at the top under **Built locally — no GitHub build record yet**, with an archive count. Their state is superseded, built locally. Existing app installations keep working. Verified GitHub outputs awaiting catalog publication appear in their own section with their exact versions and hashes; they never change the identity of an older local archive.

Each CPU build has its own row, with its minimum macOS, recipe commit, build run, attestation and recorded rebuild result. Minimum macOS is the recorded requirement of the complete native package, separately from the SDK used to compile it. [App feature requirements](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) describe which MacLauncher features each Mac can run.

## Coverage

Repository tools need Node 24.15 or newer and locked dependencies. After cloning this repository, the same verified build inventory that supplies the Pages table is available with:

```sh
npm ci --ignore-scripts
node tools/package-index.mjs --local-builds
```

Its JSON reports local catalog archives and their exact hashes, active projects missing required verification, supplied-file projects and proofs, retired projects, and signed GitHub outputs awaiting publication. Archive counts and project counts are separate: one project can have several versions and CPU builds, and a signed output can establish project coverage before that output is published. A locally built package that contains a publisher binary is classified by where the package was assembled; the publisher's binary has its own verification route below.

Project coverage counts active projects. A compiled project is complete when the newest packaging revision of each maintained version line has a verified GitHub build for each CPU. Older revisions remain in history. A universal archive can cover both CPUs; a newer native CPU package supersedes its older revision for that CPU. The report lists only the missing current version and CPU pairs. `projectsWithoutAuthority` includes both incomplete GitHub builds and missing supplied-file proofs. Registering a supplied-file project does not satisfy that requirement until its proof is verified. The summary keeps total, active and retired counts separate, including projects requiring GitHub builds, registered supplied-file projects and verified supplied outputs. The local archive count includes historical packages from retired projects. Retiring a project does not turn one of its local archives into a verified GitHub build.

Build evidence is verified with Sigstore using the TUF-validated public trust snapshot in `attestations/trusted-root.jsonl`. Package records cannot choose trust roots. Refreshing the snapshot uses the normal Sigstore TUF update, as used by `gh attestation trusted-root`; generating catalogs or importing an archive does not replace it.

An existing Runtime build artifact can add its signed evidence without publishing a catalog or release:

```sh
node tools/record-github-build.mjs --release-bundle /absolute/path/to/runtime-build-output
```

The importer verifies the actual archive, package contents and signed provenance. Optional `--bundle /absolute/path/to/signed-bundle.json` supplies a downloaded attestation instead of fetching it through GitHub CLI. The archive stays unchanged.

## Unchanged supplied files

A supplied-file project needs a registered input descriptor and its exact checksum. Its equality record compares the complete supplied application inventory, including every file's SHA-256, size and mode. The package can add bounded consumed metadata and license notices, but no production code. Marking a producer as prebuilt is insufficient. Generated metadata identifies this route as `authorityPolicy: "supplied-publisher"`; compiled packages use `github-build`.

The verification table lists supplied packages separately with their publisher version, file count, input inventory and equality record. These are not GitHub build attestations. File equality proves that the supplied files stayed unchanged; it does not authenticate their publisher. An ad-hoc code signature is not a Developer ID signature, and does not establish publisher identity.

A downloaded archive can be checked against its registered equality record without changing files:

```sh
node tools/publisher-files.mjs verify --project '<project>' \
  --archive /absolute/path/to/package.tar.gz --record /absolute/path/to/package-record.json
```

The equality record linked by the table contains the package record in its `record` field. Optional `--input-archive /absolute/path/to/supplied-input.tar.gz` also rechecks the original input archive. Both package and supplied-input hashes stay independent of any GitHub build claim.

## Retired projects

A project without a `supersededBy` reference is active. A registry record with this reference is classified as retired and stays in the registry and verification history, while its packages leave active downloads and its project leaves the active build-coverage goal. Historical versions, archive hashes, source references and signed evidence keep their original project IDs. Existing installations remain usable.

The optional registry field `supersededBy` names the immediate successor project. Generated project metadata records `state` as `active` or `retired`, and archive rows carry `projectState`. The generated pages show that successor as a link, and also show the terminal active project when a longer successor chain exists. Successor references must name registered projects and form no cycle. These links do not rename an archive, rewrite its provenance or redirect an installed runtime.

Every project has a stable verification history anchor, `#project-<project-id>`. Retired projects remain listed with their history links in the download index and in `--local-builds` output. Their local packages still appear at the top of the verification table under **Built locally — no GitHub build record yet**; their signed builds remain visible as retired history.

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

[Verifying MacLauncher](https://github.com/procrastinine/maclauncher/blob/master/docs/development/VERIFYING.md) describes how the app itself is built and checked, including the packages from this repository that ship inside it. [Runtime releases](docs/RELEASES.md) explains package names, release tags and publication.
