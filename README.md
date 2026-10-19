# MacLauncher Builds

Versioned runtime packages, source pins and build recipes for MacLauncher.
The package tools run with Node.js 24 or later and require no Electron app.

The repository separates runtime publication from launcher releases. Large
runtime implementations have their own source projects, including
`maclauncher-android`; smaller upstream adaptations use pinned sources and owned
patch recipes. Compiled runtimes and corresponding-source archives are release
assets. They are excluded from Git history.

## Android producer

The Android recipe pins `sources/maclauncher-android` to an exact source commit.
Builds require that original, clean checkout and explicit build input paths.

```sh
git submodule update --init sources/maclauncher-android
node tools/build-runtime.mjs --runtime android --check
node tools/build-runtime.mjs --runtime android --inputs /absolute/path/to/build-inputs.json
```

The source project records its upstream checkouts and build prerequisites.
Android images, toolchains and portable dependency artifacts are separate inputs;
they are excluded from source Git history.

## Package tools

Existing sealed runtime declarations are the package input. A declaration binds
the runtime identity, architecture, macOS requirement, manifest, corresponding
sources, file permissions, checksums and notices. Package creation verifies the
complete input inventory before writing a streaming archive, then verifies the
result without executing runtime code.

```sh
node tools/runtime-package.mjs pack \
  --input /absolute/path/to/sealed-runtime \
  --declaration /absolute/path/to/declaration.json \
  --output out/runtime.tar.gz

node tools/runtime-package.mjs verify \
  --archive out/runtime.tar.gz --sha256 <archive-sha256>

node tools/runtime-package.mjs catalog \
  --package out/runtime.tar.gz.json \
  --repository procrastinine/maclauncher-builds --output out/catalog.json
```

An array of declarations requires `--id` when it contains multiple packages.
`catalog` accepts repeated `--package` arguments. Archives contain
`runtime-package.json` and the original sealed files under `files/`. The format
supports native executables, shared libraries, Java runtime data and included
helpers. It rejects paths outside the package, aliases, extra files, mismatched
permissions/checksums and declarations restricted to local use.

`recipes/included-packages.json` records the currently selected runtime package
identities across engines. Downloads continue to use compatible upstream
releases where those already meet the runtime's requirements.

## Runtime updates

Catalog discovery and updates are explicit actions. Startup and Play retain the
selected installed version. First use can request consent to acquire a missing
runtime, install it automatically and resume Play. Refresh discovers published
versions; a separate install/use action selects an update. Installed packages
remain usable offline. This repository performs no background update checks.

`npm test` checks package round trips and rejection of altered or unsafe inputs.
