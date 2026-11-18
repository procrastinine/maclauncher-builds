# SPDX-License-Identifier: GPL-2.0-only
# Included through CMAKE_PROJECT_FEX_INCLUDE when FEX's top-level project() runs. The host targets are defined in the
# top-level directory after it finishes, when FEXCore's targets and FEX's compile settings exist, so the FEX source
# needs no host stanza. CMake defers include() but not add_subdirectory().
# The start host's native-host identity source is Objective-C; CMake enables languages only outside deferred calls.
enable_language(OBJC)
set(ANYPS5_FEX_HOST_DIR "${CMAKE_CURRENT_LIST_DIR}")
cmake_language(DEFER CALL include "${ANYPS5_FEX_HOST_DIR}/CMakeLists.txt")
