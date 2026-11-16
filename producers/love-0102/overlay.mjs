// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
function replace(file,before,after){const text=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');if(text.split(before).length!==2)throw Error('LÖVE 0.10.2 source anchor changed: '+path.basename(file));fs.writeFileSync(file,text.replace(before,after));}
/** Adapt build boundaries in disposable copies of the exact 0.10.2 inputs. */
export function applyBuildOverlay({love,megasource,luaLibrary,luaInclude,libpng}){
 const cmake=path.join(love,'CMakeLists.txt');
 applyLuaSocketRegistrationTypeOverlay({love});
 replace(cmake,'\tif(APPLE)\n\t\tmessage(FATAL_ERROR "JIT not supported yet on Mac. Please use -DLOVE_JIT=0.")\n\tendif()','\t# LuaJIT 2.1 supplies Darwin arm64 and x86_64 with the Lua 5.1 ABI.');
 const mega=path.join(megasource,'CMakeLists.txt');
 applyTheoraEncoderSelectionOverlay({megasource});
 applyPngDependencyOverlay({megasource,libpng});
 applyZlibDarwinOverlay({megasource});
 applyFreetypeDarwinOverlay({megasource});
 applySdlCocoaDeclarationsOverlay({megasource});
 applySdlArm64SpinlockOverlay({megasource});
 applySdlCoreaudioDeclarationsOverlay({megasource});
 applySdlTimerDeclarationsOverlay({megasource});
 applySdlCocoaEventDeclarationsOverlay({megasource});
 applySdlCocoaMessageboxModeDeclarationsOverlay({megasource});
 applySdlCocoaMouseDeclarationsOverlay({megasource});
 applySdlCocoaShapeDeclarationsOverlay({megasource});
 applySdlCocoaWindowDeclarationsOverlay({megasource});
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

/** Use local scopes to preserve every Cocoa message-box and display initializer in place. */
export function applySdlCocoaMessageboxModeDeclarationsOverlay({megasource}){
 const messagebox=path.join(megasource,'libs/SDL2/src/video/cocoa/SDL_cocoamessagebox.m');
 replace(messagebox,'    Cocoa_RegisterApp();\n\n    NSAlert* alert','    Cocoa_RegisterApp();\n\n    /* Keep declarations at their original initialization points in local scopes. */\n    {\n    NSAlert* alert');
 replace(messagebox,'    const SDL_MessageBoxButtonData *buttons = messageboxdata->buttons;','    {\n    const SDL_MessageBoxButtonData *buttons = messageboxdata->buttons;');
 replace(messagebox,'    SDLMessageBoxPresenter* presenter =','    {\n    SDLMessageBoxPresenter* presenter =');
 replace(messagebox,'    int returnValue = 0;','    {\n    int returnValue = 0;');
 replace(messagebox,'    return returnValue;\n}}','    return returnValue;\n    }\n    }\n    }\n    }\n}}');
 const modes=path.join(megasource,'libs/SDL2/src/video/cocoa/SDL_cocoamodes.m');
 replace(modes,'    const CGRect cgrect = CGDisplayBounds(cgdisplay);','    /* Preserve the constant display queries after the existing screen guard. */\n    {\n    const CGRect cgrect = CGDisplayBounds(cgdisplay);');
 replace(modes,'    return 0;\n}\n\nint\nCocoa_GetDisplayDPI','    return 0;\n    }\n}\n\nint\nCocoa_GetDisplayDPI');
}

/** Scope observed Cocoa mouse declarations without moving any initializer or call. */
export function applySdlCocoaMouseDeclarationsOverlay({megasource}){
 const file=path.join(megasource,'libs/SDL2/src/video/cocoa/SDL_cocoamouse.m');
 replace(file,'    const CGPoint point = CGPointMake((float)x, (float)y);','    /* Preserve mouse initializers at their existing execution points. */\n    {\n    const CGPoint point = CGPointMake((float)x, (float)y);');
 replace(file,'    return 0;\n}\n\nstatic void\nCocoa_WarpMouse(','    return 0;\n    }\n}\n\nstatic void\nCocoa_WarpMouse(');
 replace(file,'    SDL_WindowData *data = (SDL_WindowData *) window->driverdata;','    {\n    SDL_WindowData *data = (SDL_WindowData *) window->driverdata;');
 replace(file,'    CGError result;','    {\n    CGError result;');
 replace(file,'    return 0;\n}\n\nstatic int\nCocoa_CaptureMouse','    return 0;\n    }\n    }\n}\n\nstatic int\nCocoa_CaptureMouse');
 replace(file,'    Cocoa_InitMouseEventTap(mouse->driverdata);\n\n    SDL_MouseData *driverdata','    Cocoa_InitMouseEventTap(mouse->driverdata);\n\n    {\n    SDL_MouseData *driverdata');
 replace(file,'    driverdata->lastMoveY = location.y;\n}\n\nvoid\nCocoa_HandleMouseEvent','    driverdata->lastMoveY = location.y;\n    }\n}\n\nvoid\nCocoa_HandleMouseEvent');
 replace(file,'    SDL_Mouse *mouse = SDL_GetMouse();\n    SDL_MouseData *driverdata','    {\n    SDL_Mouse *mouse = SDL_GetMouse();\n    SDL_MouseData *driverdata');
 replace(file,'    const SDL_bool seenWarp = driverdata->seenWarp;','    {\n    const SDL_bool seenWarp = driverdata->seenWarp;');
 replace(file,'    driverdata->seenWarp = NO;\n\n    const NSPoint location','    driverdata->seenWarp = NO;\n\n    {\n    const NSPoint location');
 replace(file,'    float deltaX = [event deltaX];','    {\n    float deltaX = [event deltaX];');
 replace(file,'    SDL_SendMouseMotion(mouse->focus, mouse->mouseID, 1, (int)deltaX, (int)deltaY);\n}','    SDL_SendMouseMotion(mouse->focus, mouse->mouseID, 1, (int)deltaX, (int)deltaY);\n    }\n    }\n    }\n    }\n}');
}

/** Preserve the original Cocoa shaper initialization sequence using local declaration scopes. */
export function applySdlCocoaShapeDeclarationsOverlay({megasource}){
 const file=path.join(megasource,'libs/SDL2/src/video/cocoa/SDL_cocoashape.m');
 replace(file,'    SDL_WindowShaper* result = result = malloc(sizeof(SDL_WindowShaper));','    /* Scope declarations without moving shaper initialization across window calls. */\n    {\n    SDL_WindowShaper* result = result = malloc(sizeof(SDL_WindowShaper));');
 replace(file,'    SDL_ShapeData* data = malloc(sizeof(SDL_ShapeData));','    {\n    SDL_ShapeData* data = malloc(sizeof(SDL_ShapeData));');
 replace(file,'    int resized_properly = Cocoa_ResizeWindowShape(window);','    {\n    int resized_properly = Cocoa_ResizeWindowShape(window);');
 replace(file,'    return result;\n}','    return result;\n    }\n    }\n    }\n}');
}

/** Scope the observed Cocoa window locals without moving declarations or initializers across calls. */
export function applySdlCocoaWindowDeclarationsOverlay({megasource}){
 const file=path.join(megasource,'libs/SDL2/src/video/cocoa/SDL_cocoawindow.m');
 replace(file,'    id delegate = [self delegate];','    /* Preserve Cocoa window initialization order with local declaration scopes. */\n    {\n    id delegate = [self delegate];');
 replace(file,'        [delegate windowDidFinishMoving];\n    }\n}','        [delegate windowDidFinishMoving];\n    }\n    }\n}');
 replace(file,'    NSData *data = [pasteboard dataForType:desiredType];','    {\n    NSData *data = [pasteboard dataForType:desiredType];');
 replace(file,'    NSArray *array = [pasteboard propertyListForType:@"NSFilenamesPboardType"];','    {\n    NSArray *array = [pasteboard propertyListForType:@"NSFilenamesPboardType"];');
 replace(file,'    SDL_SendDropComplete(sdlwindow);\n    return YES;\n}}','    SDL_SendDropComplete(sdlwindow);\n    return YES;\n    }\n    }\n}}');
 replace(file,'        isMoving = NO;\n\n        SDL_Mouse *mouse','        isMoving = NO;\n\n        {\n        SDL_Mouse *mouse');
 replace(file,'            mouse->SetRelativeMouseMode(SDL_TRUE);\n        }\n    }\n}\n\n- (BOOL)windowShouldClose','            mouse->SetRelativeMouseMode(SDL_TRUE);\n        }\n        }\n    }\n}\n\n- (BOOL)windowShouldClose');
 replace(file,'    SDL_Window *window = _data->window;\n    NSWindow *nswindow = _data->nswindow;\n    int x, y, w, h;','    {\n    SDL_Window *window = _data->window;\n    NSWindow *nswindow = _data->nswindow;\n    int x, y, w, h;');
 replace(file,'    const BOOL zoomed = [nswindow isZoomed];','    {\n    const BOOL zoomed = [nswindow isZoomed];');
 replace(file,'        SDL_SendWindowEvent(window, SDL_WINDOWEVENT_MAXIMIZED, 0, 0);\n    }\n}\n\n- (void)windowDidMiniaturize','        SDL_SendWindowEvent(window, SDL_WINDOWEVENT_MAXIMIZED, 0, 0);\n    }\n    }\n    }\n}\n\n- (void)windowDidMiniaturize');
 replace(file,'    const unsigned int newflags = [NSEvent modifierFlags] & NSAlphaShiftKeyMask;','    {\n    const unsigned int newflags = [NSEvent modifierFlags] & NSAlphaShiftKeyMask;');
 replace(file,'    SDL_ToggleModState(KMOD_CAPS, newflags != 0);\n}','    SDL_ToggleModState(KMOD_CAPS, newflags != 0);\n    }\n}');
 replace(file,'#if !SDL_MAC_NO_SANDBOX\n            CGPoint cgpoint;','#if !SDL_MAC_NO_SANDBOX\n            {\n            CGPoint cgpoint;');
 replace(file,'            Cocoa_HandleMouseWarp(cgpoint.x, cgpoint.y);\n#endif','            Cocoa_HandleMouseWarp(cgpoint.x, cgpoint.y);\n            }\n#endif');
 replace(file,'        const SDL_FingerID fingerId = (SDL_FingerID)(intptr_t)[touch identity];','        {\n        const SDL_FingerID fingerId = (SDL_FingerID)(intptr_t)[touch identity];');
 replace(file,'            SDL_SendTouchMotion(touchId, fingerId, x, y, 1.0f);\n            break;\n        default:\n            break;\n        }\n    }','            SDL_SendTouchMotion(touchId, fingerId, x, y, 1.0f);\n            break;\n        default:\n            break;\n        }\n        }\n    }');
 replace(file,'    [super resetCursorRects];\n    SDL_Mouse *mouse','    [super resetCursorRects];\n    {\n    SDL_Mouse *mouse');
 replace(file,'                     cursor:[NSCursor invisibleCursor]];\n    }\n}','                     cursor:[NSCursor invisibleCursor]];\n    }\n    }\n}');
 replace(file,'    NSScreen *screen = nil;','    {\n    NSScreen *screen = nil;');
 replace(file,'    SDLView *contentView = [[SDLView alloc] initWithFrame:rect];','    {\n    SDLView *contentView = [[SDLView alloc] initWithFrame:rect];');
 replace(file,'    [contentView release];','    [contentView release];\n    }');
 replace(file,'    return 0;\n}}\n\nint\nCocoa_CreateWindowFrom','    return 0;\n    }\n}}\n\nint\nCocoa_CreateWindowFrom');
 replace(file,'        NSRect screenRect = [[nswindow screen] frame];','        {\n        NSRect screenRect = [[nswindow screen] frame];');
 replace(file,'        [nswindow setStyleMask:NSBorderlessWindowMask];','        }\n        [nswindow setStyleMask:NSBorderlessWindowMask];');
 replace(file,'        NSRect frameRect = [nswindow frame];','        {\n        NSRect frameRect = [nswindow frame];');
 replace(file,'        [nswindow setFrame:frameRect display:NO];','        [nswindow setFrame:frameRect display:NO];\n        }');
 replace(file,'        NSArray *contexts = [[data->nscontexts copy] autorelease];','        {\n        NSArray *contexts = [[data->nscontexts copy] autorelease];');
 replace(file,'        [data->nscontexts release];','        }\n        [data->nscontexts release];');
}

/** Use the Lua 5.1 registration type declared by the selected LuaJIT headers. */
export function applyLuaSocketRegistrationTypeOverlay({love}){
 const root=path.join(love,'src/libraries/luasocket/libluasocket');
 for(const [name,count] of [['auxiliar.c',1],['auxiliar.h',1],['except.c',1],['inet.c',1],['luasocket.c',2],['mime.c',1],['select.c',1],['tcp.c',2],['timeout.c',1],['udp.c',2],['unix.c',2]]){
  const file=path.join(root,name),text=fs.readFileSync(file,'utf8');
  if((text.match(/\bluaL_reg\b/g)||[]).length!==count)throw Error('LuaSocket registration type anchor changed: '+name);
  fs.writeFileSync(file,text.replace(/\bluaL_reg\b/g,'luaL_Reg'));
 }
}

/** Select the complete encoder, matching upstream's enabled-encoder source branch. */
export function applyTheoraEncoderSelectionOverlay({megasource}){
 replace(path.join(megasource,'libs/libtheora-1.1.1/CMakeLists.txt'),'    lib/encoder_disabled.c\n','    # Full encoder APIs are supplied by encode.c and encapiwrapper.c.\n');
}

/** Build the declared PNG source against Megasource zlib before FreeType discovery. */
export function applyPngDependencyOverlay({megasource,libpng}){
 if(!libpng||!fs.existsSync(path.join(libpng,'png.h')))throw Error('Declared libpng source is required.');
 const pngSource=libpng.replaceAll('\\','/').replaceAll('"','\\"');
 replace(path.join(megasource,'CMakeLists.txt'),'add_subdirectory("libs/freetype-${MEGA_FREETYPE_VER}" ${CMAKE_BINARY_DIR}/freetype)',`# The declared PNG/zlib targets supply FreeType's complete PNG support.
 set(ZLIB_INCLUDE_DIR "\${CMAKE_CURRENT_SOURCE_DIR}/libs/zlib-\${MEGA_ZLIB_VER}")
 set(ZLIB_INCLUDE_DIRS "\${ZLIB_INCLUDE_DIR}" "\${CMAKE_BINARY_DIR}/zlib")
 set(ZLIB_LIBRARY zlibstatic)
 if(NOT TARGET ZLIB::ZLIB)
  add_library(ZLIB::ZLIB ALIAS zlibstatic)
 endif()
 set(PNG_SHARED OFF)
 set(PNG_STATIC ON)
 set(PNG_FRAMEWORK OFF)
 set(PNG_TESTS OFF)
 set(PNG_TOOLS OFF)
 add_subdirectory("${pngSource}" "\${CMAKE_BINARY_DIR}/libpng")
 set(PNG_PNG_INCLUDE_DIR "${pngSource}")
 add_library(PNG::PNG ALIAS png_static)
 set(PNG_LIBRARY png_static)
 set(PNG_LIBRARY_RELEASE png_static)
 set(PNG_LIBRARY_DEBUG png_static)
 set(PNG_LIBRARIES png_static)
 add_subdirectory("libs/freetype-\${MEGA_FREETYPE_VER}" \${CMAKE_BINARY_DIR}/freetype)`);
}
