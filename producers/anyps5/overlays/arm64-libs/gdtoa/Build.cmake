# SPDX-License-Identifier: GPL-2.0-only
set(anyps5Gdtoa "${CMAKE_CURRENT_SOURCE_DIR}/gdtoa")
add_library(anyps5_gdtoa80 OBJECT
    ${CMAKE_CURRENT_SOURCE_DIR}/src/GuestFloat80.cpp
    ${anyps5Gdtoa}/port/GuestGdtoa.c
    ${anyps5Gdtoa}/vendor/dmisc.c
    ${anyps5Gdtoa}/vendor/gethex.c
    ${anyps5Gdtoa}/vendor/gmisc.c
    ${anyps5Gdtoa}/vendor/hd_init.c
    ${anyps5Gdtoa}/vendor/hexnan.c
    ${anyps5Gdtoa}/vendor/misc.c
    ${anyps5Gdtoa}/vendor/smisc.c
    ${anyps5Gdtoa}/vendor/strtodg.c
    ${anyps5Gdtoa}/vendor/sum.c
    ${anyps5Gdtoa}/vendor/ulp.c
)
set_target_properties(anyps5_gdtoa80 PROPERTIES POSITION_INDEPENDENT_CODE ON C_VISIBILITY_PRESET hidden)
target_include_directories(anyps5_gdtoa80 PRIVATE ${anyps5Gdtoa}/port ${anyps5Gdtoa}/vendor/arch ${anyps5Gdtoa}/vendor)
target_include_directories(anyps5_gdtoa80 PRIVATE ${LIBS_INCLUDE_DIR})
target_compile_definitions(anyps5_gdtoa80 PRIVATE MULTIPLE_THREADS=1)
target_compile_options(anyps5_gdtoa80 PRIVATE -include ${anyps5Gdtoa}/port/GuestGdtoaPlatform.h)
target_sources(libc PRIVATE $<TARGET_OBJECTS:anyps5_gdtoa80>)
add_dependencies(libc anyps5_gdtoa80)
