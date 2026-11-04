# ReMinori

ReMinori builds from the source commit selected in the project registry. The Runtime build recipe compiles the engine, PAZ/PE probe and FFmpeg movie bridge for Apple Silicon or Intel, then seals the native library closure and package metadata. The package requires macOS 13 or later.

Available licence texts from the source and Cargo directories use the shared [licence intake](SOURCE_PINS.md#licences). Missing or unreadable texts produce a warning.

The recipe uses the same Runtime build, package preparation and verification commands as other projects. [VERIFYING.md](../VERIFYING.md) describes archive verification and rebuild comparison.
