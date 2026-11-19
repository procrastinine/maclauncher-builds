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
# The proof calls one export, so it links the AnyPS5 objects as an archive and takes only the members that export
# reaches; the start host binds every export, so it links them whole. Both link every symbol they reference: a missing
# definition fails the build.
add_library(anyps5-arm64-objects STATIC ${ANYPS5_ARM64_OBJECTS})
set_target_properties(anyps5-arm64-objects PROPERTIES LINKER_LANGUAGE CXX)
set(ANYPS5_HOST_SOURCES ${H}/KernelThreadRecord.cpp ${H}/GuestImages.cpp ${H}/GuestThreads.cpp ${H}/HostLibc.cpp
  ${ANYPS5_SOURCE_DIR}/core/libs/nid/src/NidCompute.cpp ${ANYPS5_SOURCE_DIR}/core/libs/nid/src/Sha1.cpp)
add_executable(anyps5-fex-proof ${H}/AnyPS5FexProof.cpp ${ANYPS5_HOST_SOURCES})
target_link_libraries(anyps5-fex-proof PRIVATE anyps5-arm64-objects)
add_executable(anyps5-fex-abi ${H}/AnyPS5FexAbi.cpp ${H}/GenericBridge.S)
add_executable(anyps5-fex-start ${H}/AnyPS5FexStart.cpp ${ANYPS5_HOST_SOURCES} ${ANYPS5_GENERATED_THUNKS} ${ANYPS5_ARM64_OBJECTS})
foreach(Target anyps5-fex-proof anyps5-fex-start)
  target_include_directories(${Target} PRIVATE ${H} ${ANYPS5_SOURCE_DIR}/core/libs ${ANYPS5_SOURCE_DIR}/core/libs/nid/include ${ANYPS5_ARM64_INCLUDES})
  target_link_libraries(${Target} PRIVATE ${ANYPS5_ARM64_LINK})
  target_compile_definitions(${Target} PRIVATE ${ANYPS5_ARM64_DEFINES})
  # A dynamic library among them (SDL) sits next to the executable, the only place the executables look for one.
  set_target_properties(${Target} PROPERTIES BUILD_WITH_INSTALL_RPATH TRUE INSTALL_RPATH "@executable_path")
endforeach()
# The start host serves the main dispatch queue on the main thread with a CFRunLoop.
target_link_libraries(anyps5-fex-start PRIVATE "-framework CoreFoundation")
# It runs from its version's shared bundle and takes the game's name and Dock icon in-process, with the shared
# native-host identity source build-proof.mjs copies beside these files.
target_sources(anyps5-fex-start PRIVATE ${H}/maclauncher-application-identity.m)
set_source_files_properties(${H}/maclauncher-application-identity.m PROPERTIES COMPILE_OPTIONS "-fobjc-arc;-fblocks")
target_link_libraries(anyps5-fex-start PRIVATE "-framework AppKit")
# The shipped host retains symbols without the linked debug map of local archive member paths.
target_link_options(anyps5-fex-start PRIVATE "-Wl,-S")
add_executable(anyps5-fex-syscall ${H}/AnyPS5FexSyscall.cpp)
add_executable(anyps5-fex-exception ${H}/AnyPS5FexException.cpp)
foreach(Target anyps5-fex-proof anyps5-fex-abi anyps5-fex-start anyps5-fex-syscall anyps5-fex-exception)
  target_link_libraries(${Target} PRIVATE FEXCore FEXCore_Base JemallocDummy)
  target_include_directories(${Target} PRIVATE ${CMAKE_BINARY_DIR}/generated)
  set_target_properties(${Target} PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/Bin)
endforeach()
