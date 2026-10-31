# ReMinori

ReMinori builds from the source commit selected in the project registry. The Runtime build recipe compiles the engine, PAZ/PE probe and FFmpeg movie bridge for Apple Silicon or Intel, then seals the native library closure and package metadata. The package requires macOS 13 or later.

The package includes ReMinori's original AGPL-3.0 license from that source commit, FFmpeg's license and notices for Rust dependencies and the standard library. Some locked crate archives omit their license text. producers/reminori/licenses.json declares exact upstream notice files for those crates. Where the upstream version also omits a file, the recipe supplies the standard SPDX license text with the authors recorded in the crate's Cargo.toml. Every additional notice is checked against its declared SHA-256 and byte count; its crate name, version, license and authors must match Cargo metadata. A missing or mismatched notice fails the build.

The recipe uses the same Runtime build, package preparation and verification commands as other projects. [VERIFYING.md](../VERIFYING.md) describes archive verification and rebuild comparison.
