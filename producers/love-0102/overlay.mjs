// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
function replace(file,before,after){const text=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');if(text.split(before).length!==2)throw Error('LÖVE 0.10.2 source anchor changed: '+path.basename(file));fs.writeFileSync(file,text.replace(before,after));}
/** Adapt build boundaries in disposable copies of the exact 0.10.2 inputs. */
export function applyBuildOverlay({love,megasource,luaLibrary,luaInclude}){
 const cmake=path.join(love,'CMakeLists.txt');
 replace(cmake,'\tif(APPLE)\n\t\tmessage(FATAL_ERROR "JIT not supported yet on Mac. Please use -DLOVE_JIT=0.")\n\tendif()','\t# LuaJIT 2.1 supplies Darwin arm64 and x86_64 with the Lua 5.1 ABI.');
 const mega=path.join(megasource,'CMakeLists.txt');
 replace(path.join(megasource,'libs/physfs-2.0.3/CMakeLists.txt'),'SET(OTHER_LDFLAGS ${OTHER_LDFLAGS} " -framework Carbon -framework IOKit")','SET(OTHER_LDFLAGS ${OTHER_LDFLAGS} "-framework Carbon" "-framework IOKit")');
 replace(path.join(megasource,'libs/libtheora-1.1.1/CMakeLists.txt'),'\tadd_library(theora SHARED ${THEORA_SRC} lib/theora.def)','\tset(THEORA_SHARED_PLATFORM_SOURCES)\n\tif(WIN32)\n\t\tlist(APPEND THEORA_SHARED_PLATFORM_SOURCES lib/theora.def)\n\tendif()\n\tadd_library(theora SHARED ${THEORA_SRC} ${THEORA_SHARED_PLATFORM_SOURCES})');

 for(const[from,to]of [['set(OGG_LIBRARY ogg-static)','set(OGG_LIBRARY ogg)'],['set(MEGA_PHYSFS physfs-static)','set(MEGA_PHYSFS physfs)'],['set(MEGA_LIBOGG ogg-static)','set(MEGA_LIBOGG ogg)'],['set(MEGA_LIBVORBIS vorbis-static)','set(MEGA_LIBVORBIS vorbis)'],['set(MEGA_LIBVORBISFILE vorbisfile-static)','set(MEGA_LIBVORBISFILE vorbisfile)'],['set(MEGA_LIBTHEORA theora-static)','set(MEGA_LIBTHEORA theora)'],['set(MEGA_MODPLUG modplug-static)','set(MEGA_MODPLUG modplug)']])replace(mega,from,to);
 replace(mega,'if(EXISTS ${MEGA_LOVE}/CMakeLists.txt)',`if(APPLE)
 if(NOT EXISTS "${luaLibrary}" OR NOT EXISTS "${luaInclude}/lua.h" OR NOT EXISTS "${luaInclude}/luajit.h")
  message(FATAL_ERROR "The prepared LuaJIT library and headers are required.")
 endif()
 add_library(luajit SHARED IMPORTED GLOBAL)
 set_target_properties(luajit PROPERTIES IMPORTED_LOCATION "${luaLibrary}" INTERFACE_INCLUDE_DIRECTORIES "${luaInclude}")
 set(MEGA_LUAJIT_LIB luajit)
 set(MEGA_LUAJIT_INCLUDE "${luaInclude}")
 # Embedded production helpers remain static; external native libraries are frameworks.
 set(BUILD_SHARED_LIBS OFF)
 add_definitions(-DHAS_SOCKLEN_T)
endif()
if(EXISTS \${MEGA_LOVE}/CMakeLists.txt)`);
 fs.appendFileSync(mega,`
if(APPLE)
 foreach(pair "ogg;Ogg" "vorbis;Vorbis" "vorbisfile;Vorbisfile" "theora;Theora" "modplug;libmodplug" "physfs;physfs" "freetype;FreeType" "SDL2;SDL2" "openal;OpenAL-Soft" "mpg123;mpg123" "liblove;love")
  list(GET pair 0 target)
  list(GET pair 1 name)
  if(NOT TARGET \${target})
   message(FATAL_ERROR "Missing declared native library target: \${target}")
  endif()
  set_target_properties(\${target} PROPERTIES FRAMEWORK TRUE FRAMEWORK_VERSION A OUTPUT_NAME "\${name}" MACOSX_FRAMEWORK_IDENTIFIER "org.love2d.\${name}" BUILD_WITH_INSTALL_NAME_DIR TRUE INSTALL_NAME_DIR "@rpath")
 endforeach()
 # Framework linkage is added from the parent dependency project.
 cmake_policy(SET CMP0079 NEW)
 target_link_libraries(liblove "-framework Cocoa" "-framework Foundation" "-framework OpenGL")
 set_target_properties(love PROPERTIES BUILD_WITH_INSTALL_RPATH TRUE INSTALL_RPATH "@executable_path/../Frameworks")
 file(GENERATE OUTPUT "\${CMAKE_BINARY_DIR}/love-outputs.txt" CONTENT "$<TARGET_FILE:love>\\n$<TARGET_FILE:liblove>\\n$<TARGET_FILE:ogg>\\n$<TARGET_FILE:vorbis>\\n$<TARGET_FILE:vorbisfile>\\n$<TARGET_FILE:theora>\\n$<TARGET_FILE:modplug>\\n$<TARGET_FILE:physfs>\\n$<TARGET_FILE:freetype>\\n$<TARGET_FILE:SDL2>\\n$<TARGET_FILE:openal>\\n$<TARGET_FILE:mpg123>\\n")
endif()
`);
}
