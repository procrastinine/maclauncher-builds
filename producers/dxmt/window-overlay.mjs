import fs from 'node:fs';
import path from 'node:path';

// Window presentation adapted from dttdrv/mullion d7d99957a8e93fab31ab331bb53f8087e30bf077.
// The original legacy mac-driver path remains available. The added path owns
// only its layer/view and addresses Wine's existing Cocoa window by its HWND.
const placement = `struct WMTWindowPlacement {
  uint64_t top_level;
  int32_t x, y, width, height;
  int32_t top_level_width, top_level_height;
  uint32_t screen_width;
};
`;
const native = `
@interface DXMTMetalView : NSView
@end
@implementation DXMTMetalView
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end
@interface DXMTMetalHost : NSObject {
@public
  CAMetalLayer *layer;
  NSView *view;
  struct WMTWindowPlacement placement;
  BOOL placed;
  BOOL pending;
}
@end
@implementation DXMTMetalHost
@end

static BOOL DXMTPlace(DXMTMetalHost *host, struct WMTWindowPlacement placement) {
  if (!placement.screen_width || placement.width <= 0 || placement.height <= 0) return NO;
  for (NSWindow *window in [NSApp windows]) {
    if (![window respondsToSelector:@selector(hwnd)] ||
        (uint32_t)(uintptr_t)((void *(*)(id, SEL))objc_msgSend)(window, @selector(hwnd)) != (uint32_t)placement.top_level)
      continue;
    NSView *content = window.contentView;
    NSScreen *screen = NSScreen.screens.firstObject;
    if (!screen || screen.frame.size.width <= 0) return NO;
    CGFloat scale = placement.screen_width / screen.frame.size.width;
    CGFloat border = (content.bounds.size.width - placement.top_level_width / scale) / 2;
    CGFloat above = content.bounds.size.height - placement.top_level_height / scale - border;
    NSRect area = NSMakeRect(border + placement.x / scale, above + placement.y / scale,
                            placement.width / scale, placement.height / scale);
    if (!content.isFlipped) area.origin.y = content.bounds.size.height - NSMaxY(area);
    if (!host->view) {
      host->view = [[DXMTMetalView alloc] initWithFrame:area];
      host->view.layer = host->layer;
      host->view.wantsLayer = YES;
    }
    if (host->view.superview != content)
      [content addSubview:host->view positioned:NSWindowAbove relativeTo:nil];
    host->view.frame = area;
    return YES;
  }
  return NO;
}

static void DXMTSchedule(DXMTMetalHost *host, struct WMTWindowPlacement placement) {
  @synchronized(host) {
    if (host->placed && !memcmp(&host->placement, &placement, sizeof(placement))) return;
    host->placement = placement;
    if (host->pending) return;
    host->pending = YES;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    struct WMTWindowPlacement current;
    @synchronized(host) { current = host->placement; }
    BOOL placed = DXMTPlace(host, current);
    @synchronized(host) {
      host->placed = placed && !memcmp(&host->placement, &current, sizeof(current));
      host->pending = NO;
    }
  });
}

static NTSTATUS _UpdateMetalViewPlacement(void *obj) {
  struct unixcall_update_metal_view_placement *params = obj;
  if (![(id)params->view isKindOfClass:[DXMTMetalHost class]]) return STATUS_SUCCESS;
  DXMTMetalHost *host = (DXMTMetalHost *)params->view;
  struct WMTWindowPlacement placement = params->placement;
  DXMTSchedule(host, placement);
  return STATUS_SUCCESS;
}
`;
const windows = `
static struct WMTWindowPlacement DXMTWindowPlacement(intptr_t hwnd) {
  DPI_AWARENESS_CONTEXT awareness = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  HWND window = (HWND)hwnd, top = GetAncestor(window, GA_ROOT);
  RECT client = {0}, around = {0};
  GetClientRect(window, &client); GetClientRect(top, &around);
  MapWindowPoints(window, top, (POINT *)&client, 2);
  struct WMTWindowPlacement result = {
    (uint64_t)(uintptr_t)top, client.left, client.top, client.right-client.left, client.bottom-client.top,
    around.right, around.bottom, (uint32_t)GetSystemMetrics(SM_CXSCREEN)
  };
  if (awareness) SetThreadDpiAwarenessContext(awareness);
  return result;
}
`;
function edit(root, file, before, after) {
  const full = path.join(root, file), text = fs.readFileSync(full, 'utf8');
  if (text.split(before).length !== 2) throw Error('DXMT window source anchor changed: ' + file);
  fs.writeFileSync(full, text.replace(before, after));
}
export function applyWindowOverlay(root) {
  const prefix='src/winemetal/';
  edit(root,prefix+'unix/winemetal_unix.c','#include <dlfcn.h>','#include <dlfcn.h>\n#include <objc/message.h>\n#include <string.h>');
  edit(root,prefix+'winemetal.h','WINEMETAL_API obj_handle_t CreateMetalViewFromHWND',placement+'\nWINEMETAL_API void UpdateMetalViewPlacement(intptr_t hwnd, obj_handle_t view);\n\nWINEMETAL_API obj_handle_t CreateMetalViewFromHWND');
  edit(root,prefix+'winemetal_thunks.h','struct unixcall_create_metal_view_from_hwnd {','struct unixcall_update_metal_view_placement {\n  obj_handle_t view;\n  struct WMTWindowPlacement placement;\n};\n\nstruct unixcall_create_metal_view_from_hwnd {\n  struct WMTWindowPlacement placement;');
  edit(root,prefix+'winemetal_thunks.h','struct unixcall_enumerate {',`#include <stddef.h>
#ifdef __cplusplus
#define DXMT_WINDOW_ASSERT(condition) static_assert(condition)
#else
#define DXMT_WINDOW_ASSERT(condition) _Static_assert(condition, #condition)
#endif
DXMT_WINDOW_ASSERT(sizeof(struct WMTWindowPlacement) == 40);
DXMT_WINDOW_ASSERT(sizeof(struct unixcall_update_metal_view_placement) == 48);
DXMT_WINDOW_ASSERT(offsetof(struct unixcall_create_metal_view_from_hwnd, hwnd) == 40);
DXMT_WINDOW_ASSERT(sizeof(struct unixcall_create_metal_view_from_hwnd) == 72);
#undef DXMT_WINDOW_ASSERT

struct unixcall_enumerate {`);
  edit(root,prefix+'winemetal_thunks.c','#include "winemetal_thunks.h"','#include <windows.h>\n#include "winemetal_thunks.h"');
  edit(root,prefix+'winemetal_thunks.c','WINEMETAL_API obj_handle_t\nCreateMetalViewFromHWND',windows+'\nWINEMETAL_API obj_handle_t\nCreateMetalViewFromHWND');
  edit(root,prefix+'winemetal_thunks.c','  params.hwnd = (uint64_t)(uintptr_t)hwnd;','  params.hwnd = (uint64_t)(uintptr_t)hwnd;\n  params.placement = DXMTWindowPlacement(hwnd);');
  const source=fs.readFileSync(path.join(root,prefix+'unix/winemetal_unix.c'),'utf8');
  const tables=[...source.matchAll(/const void \*__wine_unix_call(?:_wow64)?_funcs\[\] = \{([\s\S]+?)\};/g)];
  if(tables.length!==2)throw Error('DXMT requires both original Unix call tables.');
  const counts=tables.map(t=>t[1].split(',').filter(s=>s.trim()).length);
  if(counts[0]!==counts[1])throw Error('DXMT Unix call tables disagree.');
  edit(root,prefix+'winemetal_thunks.c','WINEMETAL_API void\nReleaseMetalView',`WINEMETAL_API void
UpdateMetalViewPlacement(intptr_t hwnd, obj_handle_t view) {
  struct unixcall_update_metal_view_placement params;
  params.view = view;
  params.placement = DXMTWindowPlacement(hwnd);
  UNIX_CALL(${counts[0]}, &params);
}

WINEMETAL_API void
ReleaseMetalView`);
  edit(root,prefix+'unix/winemetal_unix.c','static NTSTATUS\n_CreateMetalViewFromHWND',native+'\nstatic NTSTATUS\n_CreateMetalViewFromHWND');
  edit(root,prefix+'unix/winemetal_unix.c','    pfn_release_win_data(win_data);\n  }','    pfn_release_win_data(win_data);\n  } else if (objc_getClass("WineWindow")) {\n    DXMTMetalHost *host = [[DXMTMetalHost alloc] init];\n    [CATransaction begin];\n    host->layer = [[CAMetalLayer alloc] init];\n    host->layer.device = (id<MTLDevice>)params->device;\n    [CATransaction commit];\n    [CATransaction flush];\n    params->ret_view = (obj_handle_t)host;\n    params->ret_layer = (obj_handle_t)host->layer;\n    struct WMTWindowPlacement placement = params->placement;\n    DXMTSchedule(host, placement);\n  }');
  edit(root,prefix+'unix/winemetal_unix.c','  if (pfn_macdrv_view_release_metal_view)\n    pfn_macdrv_view_release_metal_view','  if ([(id)params->handle isKindOfClass:[DXMTMetalHost class]]) {\n    DXMTMetalHost *host = (DXMTMetalHost *)params->handle;\n    dispatch_async(dispatch_get_main_queue(), ^{\n      [host->view removeFromSuperview]; [host->view release];\n      [host->layer release]; [host release];\n    });\n  } else if (pfn_macdrv_view_release_metal_view)\n    pfn_macdrv_view_release_metal_view');
  for (const table of tables) edit(root,prefix+'unix/winemetal_unix.c',table[0],table[0].replace(/\n\};$/,'\n    &_UpdateMetalViewPlacement,\n};'));
  for(const api of ['d3d11','d3d12']){
    const file='src/'+api+'/'+api+'_swapchain.cpp';
    const body=fs.readFileSync(path.join(root,file),'utf8');
    const match=body.match(/(Present1\(UINT SyncInterval, UINT PresentFlags,[\s\S]*?pPresentParameters\) final \{)/);
    if(!match)throw Error('DXMT Present1 source anchor changed: '+api);
    edit(root,file,match[1],match[1]+'\n    ::UpdateMetalViewPlacement((intptr_t)hWnd, native_view_.handle);');
  }
  return {originalTableCount:counts[0],tableCount:counts[0]+1};
}
