// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
function replace(file,before,after){const text=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');if(text.split(before).length!==2)throw Error('LÖVE 0.10.2 source anchor changed: '+path.basename(file));fs.writeFileSync(file,text.replace(before,after));}
/** Adapt build boundaries in disposable copies of the exact 0.10.2 inputs. */
export function applyBuildOverlay({love,megasource,luaLibrary,luaInclude}){
 const cmake=path.join(love,'CMakeLists.txt');
 replace(cmake,'\tif(APPLE)\n\t\tmessage(FATAL_ERROR "JIT not supported yet on Mac. Please use -DLOVE_JIT=0.")\n\tendif()','\t# LuaJIT 2.1 supplies Darwin arm64 and x86_64 with the Lua 5.1 ABI.');
 const mega=path.join(megasource,'CMakeLists.txt');
 applyZlibDarwinOverlay({megasource});
 applyFreetypeDarwinOverlay({megasource});
 applySdlCocoaDeclarationsOverlay({megasource});
 applySdlArm64SpinlockOverlay({megasource});
 applySdlCoreaudioDeclarationsOverlay({megasource});
 applySdlTimerDeclarationsOverlay({megasource});
 applySdlCocoaEventDeclarationsOverlay({megasource});
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

/** Darwin provides POSIX fdopen; the classic Mac fallback must not replace it. */
export function applyZlibDarwinOverlay({megasource}){
 replace(path.join(megasource,'libs/zlib-1.2.8/zutil.h'),'#if defined(MACOS) || defined(TARGET_OS_MAC)','#if (defined(MACOS) || defined(TARGET_OS_MAC)) && !(defined(__APPLE__) && defined(__MACH__))');
}

/** Keep the bundled gzip unsigned-byte typedef on Darwin, where TARGET_OS_MAC is also set. */
export function applyFreetypeDarwinOverlay({megasource}){
 replace(path.join(megasource,'libs/freetype-2.6.5/src/gzip/zconf.h'),'#if !defined(MACOS) && !defined(TARGET_OS_MAC)','#if (!defined(MACOS) && !defined(TARGET_OS_MAC)) || (defined(__APPLE__) && defined(__MACH__))');
}

/** Preserve initialization order while placing Cocoa bundle locals before statements. */
export function applySdlCocoaDeclarationsOverlay({megasource}){
 const file=path.join(megasource,'libs/SDL2/src/file/cocoa/SDL_rwopsbundlesupport.m');
 replace(file,'    FILE* fp = NULL;','    /* Declaration placement adapted for the existing C warning policy. */\n    FILE* fp = NULL;\n    NSFileManager* file_manager;\n    NSString* resource_path;\n    NSString* ns_string_file_component;\n    NSString* full_path_with_file_to_try;');
 for(const [type,name] of [['NSFileManager','file_manager'],['NSString','resource_path'],['NSString','ns_string_file_component'],['NSString','full_path_with_file_to_try']])replace(file,'    '+type+'* '+name+' = ','    '+name+' = ');
}

/** Supply paired strongly ordered operations for the Apple arm64 spinlock boundary. */
export function applySdlArm64SpinlockOverlay({megasource}){
 const file=path.join(megasource,'libs/SDL2/src/atomic/SDL_spinlock.c');
 replace(file,'#elif defined(_MSC_VER)\n    SDL_COMPILE_TIME_ASSERT(locksize, sizeof(*lock) == sizeof(long));','#elif defined(__APPLE__) && (defined(__aarch64__) || defined(__arm64__))\n    /* Apple arm64 uses compiler atomics with explicit ordering. */\n    int expected = 0;\n    return __atomic_compare_exchange_n(lock, &expected, 1, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST) ? SDL_TRUE : SDL_FALSE;\n\n#elif defined(_MSC_VER)\n    SDL_COMPILE_TIME_ASSERT(locksize, sizeof(*lock) == sizeof(long));');
 replace(file,'#if defined(_MSC_VER)\n    _ReadWriteBarrier();','#if defined(__APPLE__) && (defined(__aarch64__) || defined(__arm64__))\n    /* Pair the successful compare-and-swap with an ordered atomic unlock. */\n    __atomic_store_n(lock, 0, __ATOMIC_SEQ_CST);\n\n#elif defined(_MSC_VER)\n    _ReadWriteBarrier();');
}

/** Keep the constant drain interval initialized after AudioQueueStop within its own scope. */
export function applySdlCoreaudioDeclarationsOverlay({megasource}){
 const file=path.join(megasource,'libs/SDL2/src/audio/coreaudio/SDL_coreaudio.m');
 const before='        AudioQueueStop(this->hidden->audioQueue, 0);\n        const CFTimeInterval secs = (((this->spec.size / (SDL_AUDIO_BITSIZE(this->spec.format) / 8)) / this->spec.channels) / ((CFTimeInterval) this->spec.freq)) * 2.0;\n        CFRunLoopRunInMode(kCFRunLoopDefaultMode, secs, 0);';
 const after='        AudioQueueStop(this->hidden->audioQueue, 0);\n        /* Scope the constant interval after stopping playback. */\n        {\n            const CFTimeInterval secs = (((this->spec.size / (SDL_AUDIO_BITSIZE(this->spec.format) / 8)) / this->spec.channels) / ((CFTimeInterval) this->spec.freq)) * 2.0;\n            CFRunLoopRunInMode(kCFRunLoopDefaultMode, secs, 0);\n        }';
 replace(file,before,after);
}

/** Declare the Mach status before code while preserving the timer call's execution point. */
export function applySdlTimerDeclarationsOverlay({megasource}){
 const file=path.join(megasource,'libs/SDL2/src/timer/unix/SDL_systimer.c');
 replace(file,'SDL_TicksInit(void)\n{\n    if (ticks_started) {','SDL_TicksInit(void)\n{\n#if !HAVE_CLOCK_GETTIME && defined(__APPLE__)\n    /* Keep the Mach result declaration before statements. */\n    kern_return_t ret;\n#endif\n    if (ticks_started) {');
 replace(file,'    kern_return_t ret = mach_timebase_info(&mach_base_info);','    ret = mach_timebase_info(&mach_base_info);');
}

/** Keep Cocoa event and keyboard initializers at their original observable execution points. */
export function applySdlCocoaEventDeclarationsOverlay({megasource}){
 const events=path.join(megasource,'libs/SDL2/src/video/cocoa/SDL_cocoaevents.m');
 replace(events,'- (void)focusSomeWindow:(NSNotification *)aNotification\n{','- (void)focusSomeWindow:(NSNotification *)aNotification\n{\n    /* Declarations precede statements; initialization remains below the guard. */\n    SDL_VideoDevice *device;');
 replace(events,'    SDL_VideoDevice *device = SDL_GetVideoDevice();','    device = SDL_GetVideoDevice();');
 replace(events,'    if (NSApp == nil) {\n        [SDLApplication sharedApplication];','    if (NSApp == nil) {\n        NSDictionary *appDefaults;\n        [SDLApplication sharedApplication];');
 replace(events,'        NSDictionary *appDefaults = [[NSDictionary alloc] initWithObjectsAndKeys:','        appDefaults = [[NSDictionary alloc] initWithObjectsAndKeys:');
 const keyboard=path.join(megasource,'libs/SDL2/src/video/cocoa/SDL_cocoakeyboard.m');
 replace(keyboard,'HIDCallback(void *context, IOReturn result, void *sender, IOHIDValueRef value)\n{','HIDCallback(void *context, IOReturn result, void *sender, IOHIDValueRef value)\n{\n    /* Declarations precede statements; callback queries remain below their guards. */\n    IOHIDElementRef elem;\n    CFIndex pressed;');
 replace(keyboard,'    IOHIDElementRef elem = IOHIDValueGetElement(value);','    elem = IOHIDValueGetElement(value);');
 replace(keyboard,'    CFIndex pressed = IOHIDValueGetIntegerValue(value);','    pressed = IOHIDValueGetIntegerValue(value);');
 replace(keyboard,'InitHIDCallback()\n{','InitHIDCallback()\n{\n    CFDictionaryRef keyboard, keypad;\n    CFArrayRef matches;\n    CFDictionaryRef matchesList[2];');
 replace(keyboard,'    CFDictionaryRef keyboard = NULL, keypad = NULL;\n    CFArrayRef matches = NULL;','    keyboard = NULL;\n    keypad = NULL;\n    matches = NULL;');
 replace(keyboard,'    CFDictionaryRef matchesList[] = { keyboard, keypad };','    matchesList[0] = keyboard;\n    matchesList[1] = keypad;');
 replace(keyboard,'    SDL_Keycode keymap[SDL_NUM_SCANCODES];','    SDL_Keycode keymap[SDL_NUM_SCANCODES];\n    CFDataRef uchrDataRef;');
 replace(keyboard,'    CFDataRef uchrDataRef = TISGetInputSourceProperty(key_layout, kTISPropertyUnicodeKeyLayoutData);','    uchrDataRef = TISGetInputSourceProperty(key_layout, kTISPropertyUnicodeKeyLayoutData);');
 replace(keyboard,'    NSWindow *nswindow = nil;','    NSWindow *nswindow = nil;\n    NSView *parentView;');
 replace(keyboard,'    NSView *parentView = [nswindow contentView];','    parentView = [nswindow contentView];');
 replace(keyboard,'Cocoa_HandleKeyEvent(_THIS, NSEvent *event)\n{\n    SDL_VideoData *data = (SDL_VideoData *) _this->driverdata;','Cocoa_HandleKeyEvent(_THIS, NSEvent *event)\n{\n    SDL_VideoData *data = (SDL_VideoData *) _this->driverdata;\n    unsigned short scancode;\n    SDL_Scancode code;\n#if 0\n    const char *text;\n#endif');
 replace(keyboard,'    unsigned short scancode = [event keyCode];\n    SDL_Scancode code;\n#if 0\n    const char *text;\n#endif','    scancode = [event keyCode];');
}
