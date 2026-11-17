# SPDX-License-Identifier: GPL-2.0-only
# Included through CMAKE_PROJECT_FEX_INCLUDE when FEX's top-level project() runs. The host targets are defined in the
# top-level directory after it finishes, when FEXCore's targets and FEX's compile settings exist, so the FEX source
# needs no host stanza. CMake defers include() but not add_subdirectory().
set(ANYPS5_FEX_HOST_DIR "${CMAKE_CURRENT_LIST_DIR}")
cmake_language(DEFER CALL include "${ANYPS5_FEX_HOST_DIR}/CMakeLists.txt")
