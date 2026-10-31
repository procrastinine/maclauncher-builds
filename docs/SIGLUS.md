# siglus_rs

[siglus_rs](https://github.com/xmoezzz/siglus_rs) provides the native interpreter library used by MacLauncher for Siglus games. This repository compiles its `game_launcher` library from the commit selected in [source.json](../producers/vn-adaptations/source.json), using the upstream Cargo lockfile. An [Objective-C host](../producers/vn-adaptations/siglus/host.m) calls the library's `game_run_entry` interface and owns the native application lifecycle.

The shared [Runtime build workflow](../.github/workflows/runtime-build.yml) runs [build-siglus.mjs](../tools/build-siglus.mjs). It fetches the exact public source commit, exports the source to a separate work directory and compiles the library and host for ARM64 with a macOS 13 deployment target. The original checkout stays unchanged. Rust, CMake, Ninja and pkg-config are declared build tools.

The payload contains `bin/siglus-host`, `lib/libsiglus.dylib`, the interpreter license and a `siglus-profile.json` descriptor. The descriptor records the host source and final packaged file hashes. The package includes notices for upstream source, statically linked crates and the Rust standard library; the shared package manifest records every payload file.

`--probe` calls the library's metadata interface; `--run` calls its direct launch interface. Both accept a library path, game root and optional encoding. Game arguments follow `--`.

Build and comparison commands follow the shared [verification guide](../VERIFYING.md). The published package catalog records each package's measured minimum macOS version and build evidence.
