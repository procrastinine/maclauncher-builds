# SPDX-License-Identifier: GPL-2.0-only
# Built inside the FEX source projection (Source/AnyPS5FexProof) by producers/anyps5-fex/build-proof.mjs.
set(ANYPS5_ARM64_OBJECTS "" CACHE STRING "arm64 objects of the AnyPS5 library exports the hosts call")
set(ANYPS5_SOURCE_DIR "" CACHE PATH "the AnyPS5 source projection")
add_executable(anyps5-fex-proof AnyPS5FexProof.cpp ${ANYPS5_ARM64_OBJECTS})
add_executable(anyps5-fex-abi AnyPS5FexAbi.cpp GenericBridge.S)
add_executable(anyps5-fex-start AnyPS5FexStart.cpp ${ANYPS5_ARM64_OBJECTS}
  ${ANYPS5_SOURCE_DIR}/core/libs/nid/src/NidCompute.cpp ${ANYPS5_SOURCE_DIR}/core/libs/nid/src/Sha1.cpp)
target_include_directories(anyps5-fex-start PRIVATE ${ANYPS5_SOURCE_DIR}/core/libs/nid/include)
foreach(Target anyps5-fex-proof anyps5-fex-abi anyps5-fex-start)
  target_link_libraries(${Target} PRIVATE FEXCore FEXCore_Base JemallocDummy)
  target_include_directories(${Target} PRIVATE ${CMAKE_BINARY_DIR}/generated)
endforeach()
