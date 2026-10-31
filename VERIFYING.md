# Verifying MacLauncher Builds

A package built by the [Runtime build workflow](.github/workflows/runtime-build.yml) carries signed GitHub build provenance. It binds the archive's SHA-256 to a public recipe commit and a GitHub Actions run. Verification can require a GitHub-hosted runner. The [verification table](https://procrastinine.github.io/maclauncher-builds/verification.html) lists each catalog package, CPU build, minimum macOS, source, build run, attestation lookup and recorded rebuild result. Each CPU archive has a separate row; minimum macOS follows the catalog's native package requirement rather than the build SDK. The [app feature requirements](https://github.com/procrastinine/maclauncher/blob/main/docs/runtimes/SYSTEM_REQUIREMENTS.md) describe which MacLauncher features each Mac can run.

## Verify a package

1. **Download the archive.** Select a package in the [package index](https://procrastinine.github.io/maclauncher-builds/) and download its release asset. Its catalog records the filename and SHA-256. GitHub CLI can download an exact asset:

   ```sh
   gh release download '<project>/v<version>/<arch>' \
     --repo procrastinine/maclauncher-builds \
     --pattern '<project>-<version>-<arch>.tar.gz'
   ```

2. **Check its signed provenance.** Set `RECIPE_COMMIT` to the full Builds commit from the verification table or the release tag's resolved commit. An upstream engine commit is a different identity. Run:

   ```sh
   gh attestation verify '<project>-<version>-<arch>.tar.gz' \
     --repo procrastinine/maclauncher-builds \
     --signer-workflow procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml \
     --source-digest "$RECIPE_COMMIT" \
     --deny-self-hosted-runners
   ```

   Success confirms that these bytes have provenance from the named workflow, source commit and runner type. A missing attestation cannot establish that history. Older packages without recorded provenance remain identified by their release tag and catalog checksum.

3. **Optionally rebuild and compare on a Mac.** This needs Node 24 or newer, Git, GitHub CLI, Xcode and Homebrew; Rust recipes also need rustup. Clone this repository, then run:

   ```sh
   node tools/rebuild-runtime.mjs --project '<project>' \
     --version '<version>' --arch '<arch>' --install-tools true \
     --output /absolute/path/to/new-comparison
   ```

   The script downloads and verifies the published archive, selects its recipe commit and runs that commit's build commands. `--install-tools true` permits installation of the recipe's declared Homebrew and Rust dependencies. The report records an archive match or lists differing files and metadata, with the observed toolchain. The manual [Rebuild and compare workflow](.github/workflows/runtime-rebuild.yml) runs the same command on a GitHub-hosted Mac. Neither operation publishes a package. An older recipe without a registered build command needs the manual instructions in its tagged source.

## What a rebuild establishes

Identical archive hashes establish a byte-for-byte match for that rebuild. Equal extracted files with different compression identify a packaging difference. A changed compiler, macOS SDK, library dependency or code signature can change native binaries. A report records the observed differences and toolchain information; it does not infer equivalence from a matching filename or a successful build.

Provenance and byte equality answer different questions. Provenance links an archive to the recipe and run that produced it. A rebuild compares a second output with that archive. Neither is a review of every upstream source line or a guarantee that software has no vulnerabilities.

## Publisher downloads

MacLauncher also uses publisher binaries that it does not compile. They are outside the claim that a MacLauncher recipe reconstructs the binary. An attestation for a package that contains such a file covers the package assembly, not the publisher's private build.

| Component | Verification |
| --- | --- |
| Valve SteamCMD | Valve's Developer ID code signature, team `MXGJJ98X76`; Steam verifies its own updates and authenticated content downloads. |
| YoYo Games Igor | YoYo Games' Developer ID code signature, team `C9E7J7HL3D`. |
| Official YoYo Games runners | Publisher HTTPS feeds supply URLs, sizes and signature metadata. MacLauncher records the downloaded SHA-256 for subsequent integrity checks; that recorded hash is not independent publisher authentication. |
| NVIDIA libraries and model files | Publisher release digests when supplied, plus recorded archive or extracted-entry hashes. No claim of reconstruction from NVIDIA's private sources. |
| Other publisher runtimes and tools | Publisher digests or signatures when available. Otherwise publisher HTTPS, format checks and an observed SHA-256 identify the installed copy. |

The [app verification reference](https://github.com/procrastinine/maclauncher/blob/main/docs/development/VERIFYING.md) describes the app archive and its chain of included packages. [Runtime releases](docs/RELEASES.md) defines package names, source tags and publication.
