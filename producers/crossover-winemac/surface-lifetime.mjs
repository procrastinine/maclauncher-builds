// Copyright (c) MacLauncher contributors. MIT license.
// Adapts the text of dlls/winemac.drv/cocoa_window.m, whose original the
// scene-window profile declares and checks.
export function adaptSurfaceLifetime(original) {
  const before = `void macdrv_view_release_metal_view(macdrv_metal_view v)
{
    WineMetalView* view = (WineMetalView*)v;
    OnMainThread(^{
        [view removeFromSuperview];
        [view release];
    });
}`;
  const after = `static void release_metal_view_on_main(macdrv_metal_view v)
{
    WineMetalView* view = (WineMetalView*)v;
    [view removeFromSuperview];
    [view release]; /* surface ownership */
    [view release]; /* request's temporary ownership */
}

void macdrv_view_release_metal_view(macdrv_metal_view v)
{
    /* Preserve the request's temporary retain explicitly, so it is released
     * inside the request rather than by block cleanup after completion. */
    [(id)v retain];

    /* Capture the opaque C handle, not an Objective-C view retained by the
     * copied request block. The surface's owning release must finish before
     * OnMainThread signals completion and its caller can free the surface. */
    if ([NSThread isMainThread])
        release_metal_view_on_main(v);
    else
        OnMainThread(^{ release_metal_view_on_main(v); });
}`;
  if (original.split(before).length !== 2)
    throw Error('The CrossOver Metal-view release anchor differs.');
  return original.replace(before, () => after);
}
