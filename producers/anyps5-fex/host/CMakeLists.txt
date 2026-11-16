# SPDX-License-Identifier: GPL-2.0-only
# Built inside the FEX source projection (Source/AnyPS5FexProof) by producers/anyps5-fex/build-proof.mjs.
set(ANYPS5_ARM64_OBJECTS "" CACHE STRING "arm64 objects of the AnyPS5 library exports the proof calls")
add_executable(anyps5-fex-proof AnyPS5FexProof.cpp ${ANYPS5_ARM64_OBJECTS})
add_executable(anyps5-fex-abi AnyPS5FexAbi.cpp GenericBridge.S)
foreach(Target anyps5-fex-proof anyps5-fex-abi)
  target_link_libraries(${Target} PRIVATE FEXCore FEXCore_Base JemallocDummy)
  target_include_directories(${Target} PRIVATE ${CMAKE_BINARY_DIR}/generated)
endforeach()
