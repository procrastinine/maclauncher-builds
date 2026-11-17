# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.16)
project(rlvm_macos LANGUAGES C CXX OBJCXX)
set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(Freetype REQUIRED)
find_package(PNG REQUIRED)
find_package(Ogg REQUIRED)
find_package(Vorbis REQUIRED)
set(Boost_USE_STATIC_LIBS ON)
find_package(Boost CONFIG REQUIRED COMPONENTS filesystem iostreams program_options serialization thread date_time)
find_library(SDL_LIBRARY SDL REQUIRED)
find_path(SDL_INCLUDE_DIR SDL/SDL.h REQUIRED)
find_library(INTL_LIBRARY intl REQUIRED)
find_path(INTL_INCLUDE_DIR libintl.h REQUIRED)
# The source lists are generated from the pinned upstream's SCons declarations.
include(${CMAKE_CURRENT_BINARY_DIR}/upstream-sources.cmake)
include_directories(${RLVM_SOURCE}/src ${RLVM_SOURCE}/vendor ${CMAKE_CURRENT_BINARY_DIR}
 ${SDL_INCLUDE_DIR} ${SDL_INCLUDE_DIR}/SDL ${INTL_INCLUDE_DIR}
 ${RLVM_SOURCE}/vendor/SDL_image/include ${RLVM_SOURCE}/vendor/SDL_mixer/include
 ${RLVM_SOURCE}/vendor/SDL_image/include/SDL ${RLVM_SOURCE}/vendor/SDL_mixer/include/SDL
 ${RLVM_SOURCE}/vendor/SDL_ttf/include ${RLVM_SOURCE}/vendor/GLEW/include
 ${RLVM_SOURCE}/vendor/guichan/include ${RLVM_SOURCE}/vendor/SDL_mixer/src)
add_compile_definitions(HAVE_CONFIG_H ENABLE_NLS CASE_SENSITIVE_FILESYSTEM _THREAD_SAFE
 NO_SDL_GLEXT FB_USE_FREETYPE LOAD_GIF LOAD_BMP LOAD_PNG WAV_MUSIC OGG_MUSIC BOOST_BIND_GLOBAL_PLACEHOLDERS)
add_compile_options(-funsigned-char -Wno-narrowing -Wno-deprecated-declarations)
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/config.h "#define HAVE_LIBSDL_image 1\n#define HAVE_LIBSDL_mixer 1\n#define HAVE_LIBSDL_ttf 1\n")
add_library(rlvm_vendor STATIC ${vendor_sources})
target_link_libraries(rlvm_vendor PUBLIC Freetype::Freetype PNG::PNG Ogg::ogg Vorbis::vorbis Vorbis::vorbisfile ${SDL_LIBRARY})
# This upstream unit uses a source-root-relative include; keep other object commands unchanged.
set_property(SOURCE "${RLVM_SOURCE}/src/systems/base/hik_renderer.cc"
 APPEND PROPERTY INCLUDE_DIRECTORIES "${RLVM_SOURCE}")
find_program(NODE_EXECUTABLE node REQUIRED)
# Embed the same pinned guichan_resources bytes and mutable filename symbols as wxInclude.
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/resource_header.h"
 COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_LIST_DIR}/resources.mjs"
  "${CMAKE_CURRENT_BINARY_DIR}/resource_header.h" ${resource_inputs}
 DEPENDS "${CMAKE_CURRENT_LIST_DIR}/resources.mjs" "${RLVM_SOURCE}/SConscript" ${resource_inputs}
 VERBATIM)
add_executable(rlvm ${engine_sources} "${CMAKE_CURRENT_BINARY_DIR}/resource_header.h")
target_link_libraries(rlvm PRIVATE rlvm_vendor Boost::filesystem Boost::iostreams Boost::program_options Boost::serialization Boost::thread Boost::date_time ${INTL_LIBRARY} iconv z bz2
 "-framework Cocoa" "-framework OpenGL" "-framework ApplicationServices" "-framework AudioToolbox" "-framework AudioUnit" "-framework CoreFoundation")
