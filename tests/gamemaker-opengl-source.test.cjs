const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native');
const Producer=require('./helpers/gamemaker-opengl.cjs');
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'opengl-native-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test("legacy graphics coordinates require the reviewed profile, owned view and actual software context", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), source = path.join(root, "logical-contract.m");
  const candidateSource = Producer.sourcePath("software-gl-v2-universal");
  fs.writeFileSync(source, `#include ${JSON.stringify(candidateSource)}
#include <assert.h>
static GLint fixtureRenderer;
static unsigned originalCalls;
@interface FixtureFormat : NSOpenGLPixelFormat @end
@implementation FixtureFormat
- (void)getValues:(GLint *)values forAttribute:(NSOpenGLPixelFormatAttribute)attribute forVirtualScreen:(GLint)screen {
    assert(attribute == NSOpenGLPFARendererID && screen == 0); *values = fixtureRenderer;
}
@end
static FixtureFormat *fixtureFormat;
@interface FixtureContext : NSOpenGLContext @end
@implementation FixtureContext
- (NSOpenGLPixelFormat *)pixelFormat { return fixtureFormat; }
- (GLint)currentVirtualScreen { return 0; }
@end
static FixtureContext *fixtureContext;
@interface YYGLView : NSView @end
@implementation YYGLView
- (NSOpenGLContext *)getContext { return fixtureContext; }
@end
static NSRect originalRect(id receiver, SEL selector, NSRect rect) {
    (void)receiver; (void)selector; originalCalls++;
    return NSMakeRect(rect.origin.x*2, rect.origin.y*2, rect.size.width*2, rect.size.height*2);
}
int main(void) { @autoreleasepool {
    fixtureFormat = [FixtureFormat alloc]; fixtureContext = [FixtureContext alloc];
    YYGLView *view = [[YYGLView alloc] initWithFrame:NSZeroRect];
    NSView *other = [[NSView alloc] initWithFrame:NSZeroRect];
    originalToBacking = originalRect; originalFromBacking = originalRect;
    const NSRect input = NSMakeRect(3,5,640,480), expected = NSMakeRect(6,10,1280,960);
    legacyLogicalRequested = NO; fixtureRenderer = 0x01020400;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),expected));
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),expected));
    assert(originalCalls == 2); // Modern/profile-disabled paths retain both real conversions.
    legacyLogicalRequested = YES; fixtureRenderer = 0x01024000;
    assert(!usesLegacySoftwareCoordinates(view));
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),expected));
    fixtureRenderer = 0x01020400;
    assert(!usesLegacySoftwareCoordinates(other));
    assert(NSEqualRects(convertFromBacking(other,@selector(convertRectFromBacking:),input),expected));
    assert(originalCalls == 4); // Hardware and other views retain their original coordinates.
    assert(usesLegacySoftwareCoordinates(view));
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),input));
    assert(originalCalls == 4);
    fixtureContext = nil;
    assert(!usesLegacySoftwareCoordinates(view));
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),expected));
    assert(originalCalls == 5); // Missing/unknown native contexts remain untouched.
    [other release]; [view release];
} return 0; }
`);
  const executable = path.join(root, "logical-contract");
  execFileSync("/usr/bin/clang", ["-Wno-deprecated-declarations", "-framework", "AppKit", source, "-o", executable], { timeout: 30000 });
  const environment = { ...process.env };
  delete environment.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  delete environment.DYLD_INSERT_LIBRARIES;
  execFileSync(executable, [], { env: environment, timeout: 10000 });
});

test("V3 selects actual fallback software once and preserves hardware, modern and pre-attachment behavior", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), source = path.join(root, "v3-native-contract.m");
  fs.writeFileSync(source, `#include ${JSON.stringify(Producer.sourcePath("software-gl-v3-universal"))}
#include <assert.h>
static GLint renderer, accelerated;
static unsigned formatQueries, attempts, originalCalls;
static BOOL failFirst;
@interface FixtureFormat : NSOpenGLPixelFormat @end
@implementation FixtureFormat
- (GLint)numberOfVirtualScreens { return 1; }
- (void)getValues:(GLint *)value forAttribute:(NSOpenGLPixelFormatAttribute)attribute forVirtualScreen:(GLint)screen {
    assert(screen == 0); formatQueries++;
    if (attribute == NSOpenGLPFARendererID) *value = renderer;
    else { assert(attribute == NSOpenGLPFAAccelerated); *value = accelerated; }
}
@end
// Context is intentionally absent: the actual runner selects its pixel format
// before the first conversion, then attaches a context to the view afterwards.
@interface YYGLView : NSView @end
@implementation YYGLView @end
static id initialize(id receiver, SEL selector, const NSOpenGLPixelFormatAttribute *attrs) {
    (void)selector; (void)attrs;
    if (failFirst && attempts++ == 0) { [receiver release]; return nil; }
    return receiver;
}
static NSRect backing(id receiver, SEL selector, NSRect rect) {
    (void)receiver; (void)selector; originalCalls++;
    return NSMakeRect(rect.origin.x*2,rect.origin.y*2,rect.size.width*2,rect.size.height*2);
}
int main(void) { @autoreleasepool {
    const NSOpenGLPixelFormatAttribute attrs[] = {NSOpenGLPFAAccelerated,NSOpenGLPFAColorSize,24,0};
    const NSRect input = NSMakeRect(3,5,640,480), scaled = NSMakeRect(6,10,1280,960);
    YYGLView *view = [[YYGLView alloc] initWithFrame:NSZeroRect];
    NSView *other = [[NSView alloc] initWithFrame:NSZeroRect];
    originalInitializer = initialize; originalToBacking = backing; originalFromBacking = backing;
    legacyLogicalRequested = YES; softwareFallbackSelected = NO;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    assert(formatQueries == 0 && originalCalls == 1); // Before format selection, native units stay intact.
    failFirst = NO; attempts = 0; renderer = 0x01024000; accelerated = 1;
    id format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && !softwareFallbackSelected && formatQueries == 0);
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    [format release]; // A successful hardware request never selects logical units.
    failFirst = YES; attempts = 0; renderer = 0x01020400; accelerated = 0;
    format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && softwareFallbackSelected && formatQueries == 2);
    assert(![view respondsToSelector:sel_registerName("getContext")]);
    for (int i = 0; i < 8; i++) {
        assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
        assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),input));
    }
    assert(formatQueries == 2 && originalCalls == 18); // No per-frame GL/format query, originals still evaluated.
    assert(NSEqualRects(convertToBacking(other,@selector(convertRectToBacking:),input),scaled));
    assert(originalCalls == 19); [format release];
    legacyLogicalRequested = NO; softwareFallbackSelected = NO; formatQueries = 0; attempts = 0;
    format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && !softwareFallbackSelected && formatQueries == 0);
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    [format release]; // Modern/profile-disabled software requests keep native conversions.
    legacyLogicalRequested = YES; attempts = 0; renderer = 0x01024000; accelerated = 1;
    format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && !softwareFallbackSelected);
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),scaled));
    [format release]; // A retry that chooses hardware is not a software qualification.
    softwareFallbackSelected = YES; failFirst = NO; attempts = 0;
    format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && !softwareFallbackSelected); [format release];
    [other release]; [view release];
} return 0; }
`);
  const executable = path.join(root, "v3-native-contract");
  execFileSync("/usr/bin/clang", ["-Wno-deprecated-declarations", "-framework", "AppKit", source, "-o", executable], { timeout: 30000 });
  const environment = { ...process.env };
  delete environment.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  delete environment.DYLD_INSERT_LIBRARIES;
  execFileSync(executable, [], { env: environment, timeout: 10000 });
});

test("pixel retry keeps profiles, recovery and buffer values, and uses a fresh receiver after failed init", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t);
  const source = path.join(root, "pixel-contract.m");
  // Include the real overlay so its parser and initializer contract are tested.
  // No enabling environment is set: AppKit itself is not swizzled in this test.
  fs.writeFileSync(source, `#include ${JSON.stringify(Producer.sourcePath("software-gl-v3-universal"))}
#include <assert.h>
@interface PixelTestReceiver : NSObject
@end
@implementation PixelTestReceiver
@end
static unsigned attempts;
static BOOL failFirst;
static NSOpenGLPixelFormatAttribute captured[2][65];
static id mockInitializer(id receiver, SEL selector, const NSOpenGLPixelFormatAttribute *attrs) {
    (void)selector;
    unsigned n = attempts++;
    assert(n < 2);
    unsigned i = 0;
    do { captured[n][i] = attrs[i]; } while (attrs[i++] && i < 65);
    if (failFirst && n == 0) { [receiver release]; return nil; }
    return receiver;
}
int main(void) {
    @autoreleasepool {
        const NSOpenGLPixelFormatAttribute exact[] = {72,73,99,4096,5,8,24,11,8,12,24,13,8,0};
        const NSOpenGLPixelFormatAttribute expected[] = {72,99,4096,5,8,24,11,8,12,24,13,8,0};
        NSOpenGLPixelFormatAttribute copied[65];
        assert(copySoftwareEligibleAttributes(exact, copied));
        assert(memcmp(copied, expected, sizeof(expected)) == 0);
        const NSOpenGLPixelFormatAttribute value73[] = {8,73,73,0};
        const NSOpenGLPixelFormatAttribute keptValue[] = {8,73,0};
        assert(copySoftwareEligibleAttributes(value73, copied));
        assert(memcmp(copied, keptValue, sizeof(keptValue)) == 0);
        const NSOpenGLPixelFormatAttribute noAccel[] = {99,0x4100,5,0};
        assert(!copySoftwareEligibleAttributes(noAccel, copied));
        const NSOpenGLPixelFormatAttribute unknown[] = {999,73,0};
        assert(!copySoftwareEligibleAttributes(unknown, copied));
        NSOpenGLPixelFormatAttribute noTerminator[64];
        for (unsigned i = 0; i < 64; i++) noTerminator[i] = NSOpenGLPFAAccelerated;
        assert(!copySoftwareEligibleAttributes(noTerminator, copied));
        assert(!copySoftwareEligibleAttributes(NULL, copied));

        originalInitializer = mockInitializer;
        failFirst = NO; attempts = 0;
        id receiver = [PixelTestReceiver alloc];
        id result = initializePixelFormat(receiver, @selector(initWithAttributes:), exact);
        assert(result == receiver && attempts == 1);
        assert(memcmp(captured[0], exact, sizeof(exact)) == 0);
        [result release];

        failFirst = YES; attempts = 0;
        result = initializePixelFormat([PixelTestReceiver alloc], @selector(initWithAttributes:), exact);
        assert(result && object_getClass(result) == [PixelTestReceiver class] && attempts == 2);
        assert(memcmp(captured[0], exact, sizeof(exact)) == 0);
        assert(memcmp(captured[1], expected, sizeof(expected)) == 0);
        [result release];

        attempts = 0;
        assert(initializePixelFormat([PixelTestReceiver alloc], @selector(initWithAttributes:), noAccel) == nil);
        assert(attempts == 1);
        attempts = 0;
        assert(initializePixelFormat([PixelTestReceiver alloc], @selector(initWithAttributes:), unknown) == nil);
        assert(attempts == 1);
    }
    return 0;
}`);
  const executable = path.join(root, "pixel-contract");
  execFileSync("/usr/bin/clang", ["-Wno-deprecated-declarations", "-framework", "AppKit", source, "-o", executable], { timeout: 30000 });
  const environment = { ...process.env };
  delete environment.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  delete environment.DYLD_INSERT_LIBRARIES;
  execFileSync(executable, [], { env: environment, timeout: 10000 });
});
