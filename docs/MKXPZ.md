# MKXP-Z

The `mkxpz` package adds macOS Unicode filename normalization to MKXP-Z's own file-system calls. Version `MCLv2-1003` builds the source at `37a04d14413454551a7b6aadbb4e93e67168accb` for Apple Silicon with a macOS 11 minimum. The publisher's separate universal build remains available through its normal upstream route.

`tools/build-mkxpz.mjs` runs the NFC producer through the shared Runtime build workflow. The recipe downloads the original source archive recorded in `runtimes/mkxpz/baseline.json`, checks its digest, applies the owned patch and verifies every changed source file. Meson selects the dependency archives and patches recorded in the upstream wrap files, each with its own digest. The SDL_image Git dependency uses the exact commit declared in `producers/maclauncher/helper-builds/mkxpz.json`, with nested dependencies at its own Gitlinks. The producer builds the engine, Ruby and graphics dependencies, and packages only runtime files and required notices.

The owned adaptation is recorded in `producers/maclauncher/src/modules/rgss/overlays/mkxpz-filename-nfc/source.json`. Original upstream files remain unchanged in their source checkout; compilation uses an exported source tree.

The [verification guide](../VERIFYING.md) describes how to verify a published archive's build record and compare a rebuild with it.
