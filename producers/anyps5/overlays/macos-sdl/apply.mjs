import fs from 'node:fs';
import path from 'node:path';
export function applySdlOverlay(root){
 const file=path.join(root,'CMakeLists.txt');let source=fs.readFileSync(file,'utf8');
 const options='set(SDL_SHARED OFF CACHE BOOL "" FORCE)\nset(SDL_STATIC ON CACHE BOOL "" FORCE)';
 if(!source.includes(options))throw Error('The pinned AnyPS5 SDL build options changed.');
 source=source.replace(options,'if(APPLE)\n    set(SDL_SHARED ON CACHE BOOL "" FORCE)\n    set(SDL_STATIC OFF CACHE BOOL "" FORCE)\nelse()\n'+options+'\nendif()');
 const add='    add_subdirectory(3rdparty/SDL2)';
 if(!source.includes(add))throw Error('The pinned AnyPS5 SDL target changed.');
 source=source.replace(add,add+'\n    if(APPLE)\n        add_library(SDL2-static INTERFACE)\n        target_link_libraries(SDL2-static INTERFACE SDL2)\n        set_target_properties(SDL2 PROPERTIES\n            BUILD_WITH_INSTALL_RPATH ON\n            INSTALL_RPATH "@loader_path"\n            INSTALL_NAME_DIR "@rpath"\n            BUILD_WITH_INSTALL_NAME_DIR ON\n            LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/core/libs/libs")\n    endif()');
 fs.writeFileSync(file,source);
}
