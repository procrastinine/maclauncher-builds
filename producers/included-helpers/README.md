# Included helpers

The profiles select the production file closure for RPGMakerDecrypter, the GameMaker software OpenGL integration helper and owned Android launch helpers. Inputs retain exact source identities and a SHA-256 inventory.

`prepare.mjs` accepts an expanded production input and a new output directory. It verifies every selected input, copies regular production files, checks native CPU slices and load dependencies, verifies or applies an ad-hoc signature, and writes the sealed package declaration next to the output. Original inputs remain unchanged.

```sh
node producers/included-helpers/prepare.mjs --id rpgmaker-decrypter --input /absolute/publish-output --output /absolute/runtime-payload
```

`rpgmaker-decrypter/` contains the source adaptation, dependency locks and .NET build recipe; its expanded source comes from the exact RPGMakerDecrypter revision. The software OpenGL source is in `gamemaker-opengl-helper/`; runtime packages carry the library, consumed protocol metadata and license. Android launch helper inputs come from the owned Android producer.
