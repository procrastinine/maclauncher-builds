# SPDX-License-Identifier: GPL-2.0-only
# Included into FEX's top-level directory by fex-entry.cmake (CMAKE_PROJECT_FEX_INCLUDE); producers/anyps5-fex/build-proof.mjs
# configures it. Paths are relative to this file, since the current source directory is FEX's.
set(H ${CMAKE_CURRENT_LIST_DIR})
set(ANYPS5_ARM64_OBJECTS "" CACHE STRING "arm64 objects of the AnyPS5 library exports the hosts call")
set(ANYPS5_SOURCE_DIR "" CACHE PATH "the AnyPS5 source projection")
set(ANYPS5_GENERATED_THUNKS "" CACHE STRING "the thunk translation units generate-thunks.py wrote")
set(ANYPS5_ARM64_LINK "" CACHE STRING "static libraries, dynamic libraries and frameworks the AnyPS5 objects link")
set(ANYPS5_ARM64_INCLUDES "" CACHE STRING "include directories the AnyPS5 libraries' headers need (SDL, Vulkan, generated headers)")
set(ANYPS5_ARM64_DEFINES "" CACHE STRING "compile definitions the AnyPS5 libraries' headers need")
add_executable(anyps5-fex-proof ${H}/AnyPS5FexProof.cpp ${H}/KernelThreadRecord.cpp ${H}/GuestImages.cpp ${ANYPS5_ARM64_OBJECTS})
add_executable(anyps5-fex-abi ${H}/AnyPS5FexAbi.cpp ${H}/GenericBridge.S)
add_executable(anyps5-fex-start ${H}/AnyPS5FexStart.cpp ${H}/KernelThreadRecord.cpp ${H}/GuestImages.cpp ${H}/GuestThreads.cpp ${ANYPS5_GENERATED_THUNKS} ${ANYPS5_ARM64_OBJECTS}
  ${ANYPS5_SOURCE_DIR}/core/libs/nid/src/NidCompute.cpp ${ANYPS5_SOURCE_DIR}/core/libs/nid/src/Sha1.cpp)
foreach(Target anyps5-fex-proof anyps5-fex-start)
  target_include_directories(${Target} PRIVATE ${H} ${ANYPS5_SOURCE_DIR}/core/libs ${ANYPS5_SOURCE_DIR}/core/libs/nid/include ${ANYPS5_ARM64_INCLUDES})
  target_link_libraries(${Target} PRIVATE ${ANYPS5_ARM64_LINK})
  target_compile_definitions(${Target} PRIVATE ${ANYPS5_ARM64_DEFINES})
  # A dynamic library among them (SDL) sits next to the executable.
  set_target_properties(${Target} PROPERTIES BUILD_RPATH "@executable_path")
endforeach()
# The start host serves the main dispatch queue on the main thread with a CFRunLoop.
target_link_libraries(anyps5-fex-start PRIVATE "-framework CoreFoundation")
add_executable(anyps5-fex-syscall ${H}/AnyPS5FexSyscall.cpp)
foreach(Target anyps5-fex-proof anyps5-fex-abi anyps5-fex-start anyps5-fex-syscall)
  target_link_libraries(${Target} PRIVATE FEXCore FEXCore_Base JemallocDummy)
  target_include_directories(${Target} PRIVATE ${CMAKE_BINARY_DIR}/generated)
  set_target_properties(${Target} PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/Bin)
endforeach()
