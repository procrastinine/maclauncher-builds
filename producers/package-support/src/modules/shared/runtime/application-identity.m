// Optional launch identity for native game hosts. No application is created here.
#import <AppKit/AppKit.h>
#include <stdlib.h>

__attribute__((constructor)) static void maclauncher_application_identity(void) {
    @autoreleasepool {
        const char *title = getenv("MACLAUNCHER_GAME_NAME"), *artwork = getenv("MACLAUNCHER_GAME_ICON");
        NSString *name = title && *title ? [NSString stringWithUTF8String:title] : nil;
        NSString *file = artwork && *artwork ? [NSString stringWithUTF8String:artwork] : nil;
        if (!name.length && !file.length) return;
        if (name.length) NSProcessInfo.processInfo.processName = name;
        __block id observer;
        observer = [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidFinishLaunchingNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
            (void)note;
            if (file.isAbsolutePath) {
                NSImage *image = [[NSImage alloc] initWithContentsOfFile:file];
                if (image) NSApp.applicationIconImage = image;
            }
            NSMenu *menu = NSApp.mainMenu.itemArray.firstObject.submenu;
            if (name.length) {
                menu.title = name;
                for (NSMenuItem *item in menu.itemArray) {
                    if (item.action == @selector(orderFrontStandardAboutPanel:)) item.title = [@"About " stringByAppendingString:name];
                    else if (item.action == @selector(hide:)) item.title = [@"Hide " stringByAppendingString:name];
                    else if (item.action == @selector(terminate:)) item.title = [@"Quit " stringByAppendingString:name];
                }
            }
            [NSNotificationCenter.defaultCenter removeObserver:observer]; observer = nil;
        }];
    }
}
