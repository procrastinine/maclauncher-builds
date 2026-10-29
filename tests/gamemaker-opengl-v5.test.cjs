const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native');
const Producer=require('./helpers/gamemaker-opengl.cjs');
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'opengl-native-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('V5 couples surface preference only to the selected legacy software attachment and restores replacements', { skip: process.platform !== 'darwin' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-opengl-v5-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'surface-lifecycle.m');
  fs.writeFileSync(source, `#include ${JSON.stringify(Producer.sourcePath('software-gl-v5-universal'))}
#include <assert.h>
static unsigned formatQueries, pixelAttempts, surfaceWrites, attachments, originalCalls;
static BOOL failFirst;
static id attachmentContext, attachmentView;
static BOOL expectedPreference;
@interface FixtureFormat : NSOpenGLPixelFormat @end
@implementation FixtureFormat
- (GLint)numberOfVirtualScreens { return 1; }
- (void)getValues:(GLint *)value forAttribute:(NSOpenGLPixelFormatAttribute)attribute forVirtualScreen:(GLint)screen {
    assert(screen == 0); formatQueries++;
    if (attribute == NSOpenGLPFARendererID) *value = kCGLRendererGenericFloatID;
    else { assert(attribute == NSOpenGLPFAAccelerated); *value = 0; }
}
@end
@interface FixtureContext : NSOpenGLContext @end
@implementation FixtureContext
- (NSOpenGLPixelFormat *)pixelFormat { assert(!"No rendering-loop pixel format queries"); return nil; }
- (GLint)currentVirtualScreen { assert(!"No rendering-loop virtual screen queries"); return 0; }
@end
@interface YYGLView : NSView { @public BOOL preference; id fixtureContext; } @end
@implementation YYGLView
- (BOOL)wantsBestResolutionOpenGLSurface { return preference; }
- (NSOpenGLContext *)getContext { return fixtureContext; }
@end
static id initializeFormat(id receiver, SEL selector, const NSOpenGLPixelFormatAttribute *attrs) {
    (void)selector; (void)attrs;
    if (failFirst && pixelAttempts++ == 0) { [receiver release]; return nil; }
    return receiver;
}
static id initializeGLContext(id receiver, SEL selector, id format, id share) {
    (void)selector; (void)format; (void)share; return receiver;
}
static void surface(id receiver, SEL selector, BOOL preference) {
    (void)selector; assert(isLegacyView(receiver)); surfaceWrites++;
    ((YYGLView *)receiver)->preference = preference;
}
static void attach(id receiver, SEL selector, id view) {
    (void)selector; attachments++; attachmentContext = receiver; attachmentView = view;
    if (isLegacyView(view)) {
        assert(((YYGLView *)view)->preference == expectedPreference);
        ((YYGLView *)view)->fixtureContext = receiver;
    }
}
static NSRect backing(id receiver, SEL selector, NSRect rect) {
    (void)receiver; (void)selector; originalCalls++;
    return NSMakeRect(rect.origin.x*2,rect.origin.y*2,rect.size.width*2,rect.size.height*2);
}
static id makeFormat(BOOL fail) {
    const NSOpenGLPixelFormatAttribute attrs[] = {NSOpenGLPFAAccelerated,NSOpenGLPFAColorSize,24,0};
    failFirst = fail; pixelAttempts = 0;
    return initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
}
static id makeContext(id format) {
    return initializeContext([FixtureContext alloc],@selector(initWithFormat:shareContext:),format,nil);
}
int main(void) { @autoreleasepool {
    originalInitializer = initializeFormat; originalContextInitializer = initializeGLContext;
    originalContextViewSetter = attach; originalSurfacePreferenceSetter = surface;
    originalToBacking = backing; originalFromBacking = backing; legacyLogicalRequested = YES;
    const NSRect input = NSMakeRect(1,2,640,480), scaled = NSMakeRect(2,4,1280,960);
    YYGLView *view = [[YYGLView alloc] initWithFrame:NSZeroRect];
    YYGLView *other = [[YYGLView alloc] initWithFrame:NSZeroRect];
    NSView *ordinary = [[NSView alloc] initWithFrame:NSZeroRect];
    // The runner's high-resolution request predates PF/context selection. It
    // stays intact until an actual qualified software context is attached.
    setSurfacePreference(view,@selector(setWantsBestResolutionOpenGLSurface:),YES);
    assert(view->preference && surfaceWrites == 1);
    id softwareFormat = makeFormat(YES), softwareContext = makeContext(softwareFormat);
    assert(formatQueries == 2);
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
    expectedPreference = NO;
    setContextView(softwareContext,@selector(setView:),view);
    assert(!view->preference && surfaceWrites == 2 && attachments == 1);
    assert(attachmentContext == softwareContext && attachmentView == view);
    // Match the preference before the original attachment. Repeated attachment
    // does not continually toggle/reallocate the already-correct surface.
    setContextView(softwareContext,@selector(setView:),view);
    assert(surfaceWrites == 2 && attachments == 2);
    setSurfacePreference(view,@selector(setWantsBestResolutionOpenGLSurface:),YES);
    assert(!view->preference && surfaceWrites == 3);
    unsigned initialWrites = surfaceWrites;
    for (int i = 0; i < 100; i++) {
        assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
        assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),input));
    }
    assert(formatQueries == 2 && surfaceWrites == initialWrites && originalCalls == 201);
    assert(NSEqualRects(convertToBacking(other,@selector(convertRectToBacking:),input),scaled));
    assert(!other->preference && !objc_getAssociatedObject(other,&surfacePreferenceKey));

    id hardwareFormat = makeFormat(NO), hardwareContext = makeContext(hardwareFormat);
    expectedPreference = YES;
    setContextView(hardwareContext,@selector(setView:),view);
    assert(view->preference && attachments == 3 && surfaceWrites == 4);
    assert(!objc_getAssociatedObject(view,&surfacePreferenceKey));
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),scaled));
    setSurfacePreference(view,@selector(setWantsBestResolutionOpenGLSurface:),YES);
    assert(view->preference && surfaceWrites == 5); // Working hardware requests are forwarded.
    expectedPreference = NO;
    setContextView(softwareContext,@selector(setView:),view);
    assert(!view->preference && surfaceWrites == 6);
    setContextView(softwareContext,@selector(setView:),nil);
    assert(view->preference && surfaceWrites == 7 && attachments == 5);
    view->fixtureContext = nil;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));

    // Preserve the caller's most recent preference for later hardware reuse.
    expectedPreference = NO; setContextView(softwareContext,@selector(setView:),view);
    setSurfacePreference(view,@selector(setWantsBestResolutionOpenGLSurface:),NO);
    expectedPreference = NO; setContextView(hardwareContext,@selector(setView:),view);
    assert(!view->preference && !objc_getAssociatedObject(view,&surfacePreferenceKey));
    // Moving the software context restores the old view and owns only the new.
    setSurfacePreference(view,@selector(setWantsBestResolutionOpenGLSurface:),YES);
    expectedPreference = NO; setContextView(softwareContext,@selector(setView:),view);
    setSurfacePreference(other,@selector(setWantsBestResolutionOpenGLSurface:),YES);
    setContextView(softwareContext,@selector(setView:),other);
    assert(view->preference && !other->preference);
    assert(!objc_getAssociatedObject(view,&surfacePreferenceKey));
    unsigned beforeOrdinary = surfaceWrites;
    setContextView(softwareContext,@selector(setView:),ordinary);
    assert(other->preference && surfaceWrites == beforeOrdinary + 1);
    assert(!objc_getAssociatedObject(ordinary,&surfacePreferenceKey));
    assert(NSEqualRects(convertToBacking(ordinary,@selector(convertRectToBacking:),input),scaled));

    // A destroyed software context cannot leave a live view permanently owned
    // by a stale pointer. Its saved preference still restores for hardware.
    @autoreleasepool {
        id transient = makeContext(softwareFormat);
        expectedPreference = NO; setContextView(transient,@selector(setView:),view);
        setSurfacePreference(view,@selector(setWantsBestResolutionOpenGLSurface:),YES);
        view->fixtureContext = nil; [transient release];
    }
    assert(![objc_getAssociatedObject(view,&surfaceOwnerKey) anyObject]);
    expectedPreference = YES; setContextView(hardwareContext,@selector(setView:),view);
    assert(view->preference && !objc_getAssociatedObject(view,&surfacePreferenceKey));
    id detachedContext = makeContext(softwareFormat);
    @autoreleasepool {
        YYGLView *transientView = [[YYGLView alloc] initWithFrame:NSZeroRect];
        expectedPreference = NO; setContextView(detachedContext,@selector(setView:),transientView);
        [transientView release];
    }
    assert(![objc_getAssociatedObject(detachedContext,&boundViewKey) anyObject]);
    expectedPreference = NO; setContextView(detachedContext,@selector(setView:),other);
    assert(!other->preference); setContextView(detachedContext,@selector(setView:),nil);
    [detachedContext release];

    legacyLogicalRequested = NO;
    id modernFormat = makeFormat(YES), modernContext = makeContext(modernFormat);
    setSurfacePreference(view,@selector(setWantsBestResolutionOpenGLSurface:),YES);
    expectedPreference = YES; unsigned beforeModern = surfaceWrites;
    setContextView(modernContext,@selector(setView:),view);
    assert(view->preference && surfaceWrites == beforeModern && formatQueries == 2);
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    view->fixtureContext = nil; other->fixtureContext = nil;
    [modernContext release]; [modernFormat release];
    [hardwareContext release]; [hardwareFormat release];
    [softwareContext release]; [softwareFormat release];
    [view release]; [other release]; [ordinary release];
    printf("{\\"surfaceLifecyclePassed\\":true,\\"formatQueries\\":%u,\\"originalConversions\\":%u,\\"attachments\\":%u,\\"surfaceWrites\\":%u}\\n",formatQueries,originalCalls,attachments,surfaceWrites);
}
    assert(![provisionalViews anyObject]);
    [pendingSoftwareFormats release]; [provisionalViews release];
    return 0;
}
`);
  const executable = path.join(root, 'surface-lifecycle');
  execFileSync('/usr/bin/clang', ['-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0', '-Wno-deprecated-declarations', '-framework', 'AppKit', source, '-o', executable], { timeout: 30000 });
  const environment = { ...process.env };
  delete environment.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  delete environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL;
  delete environment.DYLD_INSERT_LIBRARIES;
  for (const architecture of process.arch === 'arm64' ? ['arm64', 'x86_64'] : ['x86_64']) {
    const output = execFileSync('/usr/bin/arch', [`-${architecture}`, executable], { env: environment, timeout: 10000, encoding: 'utf8' });
    const receipt = JSON.parse(output);
    assert.equal(receipt.surfaceLifecyclePassed, true);
    assert.equal(receipt.formatQueries, 2);
    assert.equal(receipt.originalConversions, 206);
    assert.ok(receipt.attachments >= 10);
  }
});

