# ReMinori

ReMinori builds from the source commit selected in the project registry. The Runtime build recipe compiles the engine, PAZ/PE probe and FFmpeg movie bridge for Apple Silicon or Intel, then seals the native library closure and package metadata. The package requires macOS 13 or later.

The package includes ReMinori's original AGPL-3.0 license from that source commit, FFmpeg's license and available notices for Rust dependencies and the standard library. Some locked crate archives omit their license text. producers/reminori/licenses.json declares original upstream notice files for those crates. Missing text is reported without substituting a license. Declared files are checked against their SHA-256 and byte count; crate names, versions, license identifiers and authors must match Cargo metadata.

The recipe uses the same Runtime build, package preparation and verification commands as other projects. [VERIFYING.md](../VERIFYING.md) describes archive verification and rebuild comparison.
