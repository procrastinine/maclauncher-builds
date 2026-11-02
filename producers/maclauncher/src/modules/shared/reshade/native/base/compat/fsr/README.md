# FSR1 shader generation

CMake generates FSR1 EASU and RCAS arrays in the build directory from the owned
GLSL wrapper and pinned AMD FSR1 headers. glslang 16.6.0 is built from commit
`e1b562a8bed273a02f30b59b66a5d499793cede5` at its public KhronosGroup origin.
An existing host compiler can be selected with `FSR_GLSLANG_EXECUTABLE`.

Generation requires the header SHA-256 to match the original value recorded in
`fsr1-shaders.json`. A mismatch fails the build before the native core compiles.
Generated arrays retain AMD's MIT notice. The Metal adapter translates them
through SPIRV-Cross at setup.
