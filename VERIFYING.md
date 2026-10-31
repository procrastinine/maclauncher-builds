# Verifying MacLauncher Builds

This guide explains how the packages in this repository are made and how anyone can check them. MacLauncher Builds compiles game engines, players and helpers for [MacLauncher](https://github.com/procrastinine/maclauncher). Each package comes from a recipe: the instructions, patches and source references in this repository that turn a project's source code into a Mac package. The [Runtime build workflow](.github/workflows/runtime-build.yml) builds every package on a Mac that GitHub runs, and GitHub signs a build record that ties the package archive's SHA-256 to the recipe commit and the build run that produced it. Checking that record confirms that a downloaded archive came from that public recipe and was built on GitHub's own machines. Anyone with a Mac can also rebuild a package and compare the result.

GitHub calls a signed build record an attestation, or more fully a build provenance attestation. Each project in this repository has a catalog, a JSON file under `catalogs/` that records its published packages. The [verification table](https://procrastinine.github.io/maclauncher-builds/verification.html) collects, from these catalogs, the evidence for every published package: its version, CPU, minimum macOS version, recipe commit and build run, a link to look up its build record, and the result of any recorded rebuild. Each CPU build has its own row. The minimum macOS version is the one the catalog records for the complete package, which can differ from the SDK it was built with. [App feature requirements](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) describe which MacLauncher features each Mac can run.

## Verify a package

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

3. Optionally, rebuild the package on a Mac and compare. A rebuild needs Node 24 or newer, Git, the GitHub CLI, Xcode and Homebrew, and recipes written in Rust also need rustup. Clone this repository, then run:

   ```sh
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
