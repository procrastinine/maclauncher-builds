# Verifying MacLauncher Builds

Every compiled archive from **Build and release** has a GitHub build attestation. Its release and [package index](https://procrastinine.github.io/maclauncher-builds/) link the exact source commit and build run.

The downloaded archive can be checked with the GitHub CLI:

```sh
gh attestation verify <asset> --repo procrastinine/maclauncher-builds --signer-workflow procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml --deny-self-hosted-runners
```

The command checks the archive's signed build record and prints the source commit. That commit can be compared with the source link beside the download. The linked public recipe and its pinned inputs describe how the archive was built. The signer path is `runtime-build.yml`.

**Build and release** accepts project=release-name pairs and builds only those selected packages. It seals and attests the archives, publishes them from the same GitHub run and commits their catalogs and declarations. Ordinary source pushes run checks without building packages. Added or changed pairs in `releases.txt` start the selected component builds on GitHub. [Runtime releases](docs/RELEASES.md) describes the inputs and package records.

The [verification table](https://procrastinine.github.io/maclauncher-builds/verification.html) lists each version and CPU with its minimum macOS, source commit, build run and check command. Catalog checksums identify the exact archive bytes. An upstream engine commit identifies the engine source; the Builds commit identifies the complete recipe used to produce the package.

Existing unchanged publisher files retain their separate file-equality records. That equality does not claim a GitHub compilation or publisher authentication.

**Rebuild and compare** checks a published package's recorded recipe and compares its output. It reports differences without publishing or changing the package.

The archive also contains `files/build-definition.json` and `files/build-inputs.json`. Its sealed inventory records their hashes. The input record lists the exact release, archive digest and source build of each dependency. Each referenced archive can be checked with the same attestation command. Inputs built earlier in the run receive their own attestations and releases before consumer releases are published.

Publication transfers the same run’s archive to its release after checking its recorded SHA-256. It does not verify its own signature or vendor a trust root. The verification command above and app CI fetch current trust material through GitHub.
