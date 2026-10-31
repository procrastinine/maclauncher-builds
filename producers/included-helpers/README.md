# Included helpers

This directory holds profiles for three helper packages: RPGMakerDecrypter, the GameMaker software OpenGL helper and MacLauncher's Android launch helpers. Each profile lists every production file of its helper with the file's SHA-256, and records where the helper's source comes from.

`prepare.mjs` takes an unpacked build output and a new output directory. It verifies every selected input, copies the regular production files, checks native CPU slices and load dependencies, verifies or applies an ad-hoc signature, and writes the package declaration next to the output, leaving the original inputs unchanged.

```sh
node producers/included-helpers/prepare.mjs --id rpgmaker-decrypter --input /absolute/publish-output --output /absolute/runtime-payload
```

- `rpgmaker-decrypter/` contains the source adaptation, dependency locks and .NET build recipe. Its unpacked source comes from the recorded RPGMakerDecrypter commit.
- `gamemaker-opengl-helper/` contains the software OpenGL source. Its runtime packages carry the library, the protocol metadata that MacLauncher reads and the license.
- The Android launch helper inputs come from the [Android launcher producer](../android-launcher/README.md).
