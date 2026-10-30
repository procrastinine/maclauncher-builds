# MacLauncher Builds

MacLauncher Builds provides binary builds, version control and patch sets for the runtimes and tools that [MacLauncher](https://github.com/procrastinine/maclauncher) installs. Most of them are game engines, emulators and decompilers that need changes to run on macOS, and the core graphics components and internal helpers ship inside the app. Runtimes whose publishers already offer a working macOS build are downloaded from the publisher and are not kept here.

Each runtime and tool has its own version history. A version is released on GitHub once per CPU architecture, under a tag of the form `<project>/v<version>/<arch>`, and although the release contains only the compiled package, the tagged commit holds everything it was built from: the exact upstream commit, the patches MacLauncher applies to it and the build script. MacLauncher reads the published versions of each project from [`catalogs/`](catalogs). Refresh discovers later versions and CPU builds of managed runtimes without a launcher update.

For projects with a build record, GitHub Actions compiles packages on GitHub-hosted Macs, with separate builds for Apple Silicon and Intel. Libraries that load into a game's process are built as Universal binaries instead, because the game can run as either CPU type. [Runtime releases](docs/RELEASES.md#github-builds) describes the build workflow, its signed attestations and publication.

- [Package index](https://procrastinine.github.io/maclauncher-builds/): every package and its published versions.
- [Runtime packages](docs/PACKAGES.md): the projects in this repository and the tools that build and package them.
- [Runtime releases](docs/RELEASES.md): versions, tags, catalogs and publication.
