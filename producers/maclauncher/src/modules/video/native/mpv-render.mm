// Copyright (c) MacLauncher contributors. MIT license.
#import <AppKit/AppKit.h>
#import <QuartzCore/CAMetalLayer.h>
#import <OpenGL/OpenGL.h>
#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>
#include "gpu-surface.hpp"
#include "mpv-frame-metadata.h"
#include "presentation.h"
#include "presentation-source.h"
#include "presentation-content.h"
#include <atomic>
#include <array>
#include <deque>
#include <memory>
#include <vector>
#include <algorithm>
#include <dlfcn.h>
#include <cmath>
#include <cstring>

#define MPV_SYMBOLS(X) X(mpv_create) X(mpv_initialize) X(mpv_terminate_destroy) X(mpv_set_option_string) \
 X(mpv_get_property) X(mpv_command_async) X(mpv_wait_event) X(mpv_set_wakeup_callback) X(mpv_get_time_us) X(mpv_free) X(mpv_free_node_contents) X(mpv_observe_property) X(mpv_set_property_async) \
 X(mpv_render_context_create) X(mpv_render_context_set_update_callback) X(mpv_render_context_update) \
 X(mpv_render_context_get_info) X(mpv_render_context_render) X(mpv_render_context_report_swap) X(mpv_render_context_free)
struct MPVAPI {
#define FIELD(name) decltype(&::name) name = nullptr;
 MPV_SYMBOLS(FIELD)
#undef FIELD
 void *library = nullptr;
 decltype(&::mpv_get_time_ns) nanoseconds = nullptr;
 bool load(const char *file) {
  library = dlopen(file, RTLD_NOW | RTLD_LOCAL);if (!library) return false;
#define LOAD(name) name = reinterpret_cast<decltype(name)>(dlsym(library, #name));if (!name) return false;
  MPV_SYMBOLS(LOAD)
#undef LOAD
  nanoseconds = reinterpret_cast<decltype(nanoseconds)>(dlsym(library,"mpv_get_time_ns"));
  return true;
 }
};
static NSString *libraryArgument(NSArray<NSString*> *arguments) {
 for(NSString *argument in arguments)if([argument hasPrefix:@"--maclauncher-libmpv="])
  return [argument substringFromIndex:[@"--maclauncher-libmpv=" length]];
 return [[[NSProcessInfo.processInfo.arguments[0] stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"../Frameworks/video/libmpv.2.dylib"] stringByStandardizingPath];
}
static int inspectLibrary(NSArray<NSString*> *arguments) {
 MPVAPI api;if(!api.load(libraryArgument(arguments).fileSystemRepresentation)){fprintf(stderr,"Cannot load the managed libmpv library: %s\n",dlerror());return 1;}
 mpv_handle *mpv=api.mpv_create();if(!mpv)return 1;
 api.mpv_set_option_string(mpv,"config","no");api.mpv_set_option_string(mpv,"load-scripts","no");api.mpv_set_option_string(mpv,"vo","null");api.mpv_set_option_string(mpv,"ao","null");
 if(api.mpv_initialize(mpv)<0){api.mpv_terminate_destroy(mpv);return 1;}
 char *version=nullptr;api.mpv_get_property(mpv,"mpv-version",MPV_FORMAT_STRING,&version);
 NSMutableArray<NSString*> *filters=[NSMutableArray array];mpv_node node={};
 if(api.mpv_get_property(mpv,"option-info/scale/choices",MPV_FORMAT_NODE,&node)>=0) {
  if(node.format==MPV_FORMAT_NODE_ARRAY)for(int n=0;n<node.u.list->num;n++) {
   const auto &item=node.u.list->values[n];if(item.format==MPV_FORMAT_STRING&&item.u.string)[filters addObject:[NSString stringWithUTF8String:item.u.string]];
  }
  api.mpv_free_node_contents(&node);
 }
 if([arguments containsObject:@"--scale=help"]) {printf("Available scale filters:\n");for(NSString *name in filters)printf("  %s\n",name.UTF8String);}
 else {NSDictionary *info=@{@"schema":@1,@"decodedFrameAPI":@1,@"libraryVersion":version?[NSString stringWithUTF8String:version]:@"libmpv",@"scaleFilters":filters};NSData *data=[NSJSONSerialization dataWithJSONObject:info options:0 error:nil];fwrite(data.bytes,1,data.length,stdout);printf("\n");}
 if(version)api.mpv_free(version);api.mpv_terminate_destroy(mpv);return 0;
}
struct GraphicsAPI {
 decltype(&rsCreateFramePresenter) create = nullptr;
 decltype(&rsDestroyFramePresenter) destroy = nullptr;
 decltype(&rsSetFramePresenterSource) source = nullptr;
 decltype(&rsSubmitFramePresenterContentAtTime) submit = nullptr;
 bool load() {
  create = reinterpret_cast<decltype(create)>(dlsym(RTLD_DEFAULT,"rsCreateFramePresenter"));
  destroy = reinterpret_cast<decltype(destroy)>(dlsym(RTLD_DEFAULT,"rsDestroyFramePresenter"));
  source = reinterpret_cast<decltype(source)>(dlsym(RTLD_DEFAULT,"rsSetFramePresenterSource"));
  submit = reinterpret_cast<decltype(submit)>(dlsym(RTLD_DEFAULT,"rsSubmitFramePresenterContentAtTime"));
  return create && destroy && source && submit;
 }
};
struct VideoSlot {
 std::shared_ptr<maclauncher::video::GPUSurface> surface;
 bool busy = false;
};
struct VideoJob {
 unsigned slot;
 uint64_t delivery;
 double target;
 RSPresentationContent content;
};
@class MLVideoPlayer;
@interface MLVideoView : NSView
@property(nonatomic,weak) MLVideoPlayer *player;
@end
@interface MLVideoPlayer : NSObject<NSApplicationDelegate,NSWindowDelegate> {
 MPVAPI _api;GraphicsAPI _graphics;
 mpv_handle *_mpv;mpv_render_context *_render;
 CGLContextObj _context;
 dispatch_queue_t _renderQueue,_events;
 id<MTLDevice> _device;id<MTLCommandQueue> _commands;
 CAMetalLayer *_layer;NSWindow *_window;
 void *_presenter;
 std::array<VideoSlot,3> _slots;
 std::deque<VideoJob> _jobs;
 std::atomic<bool> _closing,_scheduled,_eventScheduled,_failed;
 std::atomic<unsigned> _width,_height;
 std::atomic<uint64_t> _epoch;
 uint64_t _presenterEpoch,_delivery,_content,_revision;
 double _clockOffset,_lastDeliveryTime;
 RSPresentationContent _lastContent,_producedContent;
 bool _timerArmed,_framePending;
 std::string _lastGPUError;
 NSArray<NSString*> *_arguments;
 NSString *_media;
}
- (instancetype)initWithArguments:(NSArray<NSString*>*)arguments;
- (void)requestRender;
- (void)requestEvents;
- (void)resize:(CGSize)size;
- (void)command:(NSArray<NSString*>*)arguments;
- (void)reportSwap;
@end
static void updated(void *value) {[(__bridge MLVideoPlayer*)value requestRender];}
static void events(void *value) {[(__bridge MLVideoPlayer*)value requestEvents];}
static void *glAddress(void *,const char *name) {return dlsym(RTLD_DEFAULT,name);}
static std::atomic<uintptr_t> nextPresenterOwner{UINT64_C(0x4d50000000000000)};
struct SurfaceLease {std::shared_ptr<maclauncher::video::GPUSurface> surface;dispatch_queue_t queue;};
static void releaseSurface(void *value) {auto *token=static_cast<SurfaceLease*>(value);dispatch_async(token->queue,^{delete token;});}
struct SwapReceipt {__weak MLVideoPlayer *player;};
static void presented(void *token,uint64_t,double time,double,uint32_t outcome) {
 auto *receipt = static_cast<SwapReceipt*>(token);
 if (time > 0 && outcome == RS_PRESENTED) [receipt->player reportSwap];
 delete receipt;
}
@implementation MLVideoView
- (BOOL)acceptsFirstResponder {return YES;}
- (BOOL)wantsUpdateLayer {return YES;}
- (void)layout {[super layout];[self.player resize:[self convertSizeToBacking:self.bounds.size]];}
- (void)viewDidChangeBackingProperties {[super viewDidChangeBackingProperties];[self setNeedsLayout:YES];}
- (void)keyDown:(NSEvent*)event {
 NSString *key = event.charactersIgnoringModifiers;
 switch(event.keyCode) {case 123:key=@"LEFT";break;case 124:key=@"RIGHT";break;case 125:key=@"DOWN";break;case 126:key=@"UP";break;
 case 53:key=@"ESC";break;case 49:key=@"SPACE";break;case 36:key=@"ENTER";break;default:break;}
 if (key.length) [self.player command:@[@"keypress",key]];
}
- (void)mouseDown:(NSEvent*)event {if(event.clickCount==2)[self.window toggleFullScreen:nil];else[self.player command:@[@"cycle",@"pause"]];}
@end
@implementation MLVideoPlayer
- (instancetype)initWithArguments:(NSArray<NSString*>*)arguments {
 if (!(self=[super init])) return nil;
 _arguments=arguments;_renderQueue=dispatch_queue_create("org.maclauncher.video.render",DISPATCH_QUEUE_SERIAL);
 _events=dispatch_queue_create("org.maclauncher.video.events",DISPATCH_QUEUE_SERIAL);_epoch=1;
 return self;
}
- (void)fail:(NSString*)message {
 if(_failed.exchange(true))return;
 fprintf(stderr,"[video] %s\n",message.UTF8String);
 dispatch_async(dispatch_get_main_queue(),^{NSAlert *alert=[NSAlert new];alert.messageText=@"Video playback could not start";alert.informativeText=message;[alert runModal];[NSApp terminate:nil];});
}
- (void)applicationDidFinishLaunching:(NSNotification*)notification {
 (void)notification;
 NSString *library=libraryArgument(_arguments);NSMutableArray<NSString*> *options=[NSMutableArray array];bool media=false;
 for (NSString *argument in _arguments) {
  if ([argument hasPrefix:@"--maclauncher-libmpv="]) continue;
  if ([argument isEqualToString:@"--"]) {media=true;continue;}
  if (media) {_media=argument;break;}
  [options addObject:argument];
 }
 if (!_media || !_api.load(library.fileSystemRepresentation)) {[self fail:@"The selected managed libmpv runtime is unavailable."];return;}
 if (!_graphics.load()) {[self fail:@"The selected graphics runtime does not support decoded video presentation."];return;}
 _device=MTLCreateSystemDefaultDevice();_commands=[_device newCommandQueue];
 _mpv=_api.mpv_create();if(!_mpv||!_commands){[self fail:@"Cannot create the video GPU producer."];return;}
 auto option=[&](const char *name,const char *value){return _api.mpv_set_option_string(_mpv,name,value)>=0;};
 option("config","no");option("vo","libmpv");option("hwdec","auto-safe");option("target-trc","srgb");option("target-prim","bt.709");option("input-default-bindings","yes");
 for (NSString *argument in options) {
  if(![argument hasPrefix:@"--"])continue;NSString *text=[argument substringFromIndex:2];NSRange equal=[text rangeOfString:@"="];
  NSString *name=equal.location==NSNotFound?text:[text substringToIndex:equal.location],*value=equal.location==NSNotFound?@"yes":[text substringFromIndex:equal.location+1];
  if([name isEqualToString:@"vo"]||[name isEqualToString:@"autofit"]||[name isEqualToString:@"force-window"])continue;
  if([name hasPrefix:@"no-"]&&equal.location==NSNotFound){name=[name substringFromIndex:3];value=@"no";}
  if(!option(name.UTF8String,value.UTF8String)){[self fail:[@"Unsupported video option: " stringByAppendingString:name]];return;}
 }
 if(_api.mpv_initialize(_mpv)<0){[self fail:@"Cannot initialize the selected video runtime."];return;}
 _clockOffset=CACurrentMediaTime()-(_api.nanoseconds?double(_api.nanoseconds(_mpv))*1e-9:double(_api.mpv_get_time_us(_mpv))*1e-6);
 _api.mpv_set_wakeup_callback(_mpv,events,(__bridge void*)self);
 _api.mpv_observe_property(_mpv,1,"fullscreen",MPV_FORMAT_FLAG);
 _layer=[CAMetalLayer layer];_layer.device=_device;_layer.pixelFormat=MTLPixelFormatBGRA8Unorm;_layer.framebufferOnly=NO;
 CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);_layer.colorspace=color;CGColorSpaceRelease(color);
 NSRect screen=NSScreen.mainScreen.visibleFrame;NSRect frame=NSMakeRect(0,0,std::min(1100.0,screen.size.width*.8),std::min(700.0,screen.size.height*.8));
 _window=[[NSWindow alloc]initWithContentRect:frame styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
 _window.title=_media.lastPathComponent;_window.delegate=self;
 MLVideoView *view=[[MLVideoView alloc]initWithFrame:frame];view.player=self;view.wantsLayer=YES;view.layer=_layer;_window.contentView=view;
 [_window center];[_window makeKeyAndOrderFront:nil];[_window makeFirstResponder:view];[NSApp activateIgnoringOtherApps:YES];[view setNeedsLayout:YES];
 dispatch_async(_renderQueue,^{@autoreleasepool {
  CGLPixelFormatAttribute attributes[]={kCGLPFAAccelerated,kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,(CGLPixelFormatAttribute)0};
  CGLPixelFormatObj format;GLint count=0;CGLError error=CGLChoosePixelFormat(attributes,&format,&count);
  if(error==kCGLNoError){error=CGLCreateContext(format,nullptr,&self->_context);CGLReleasePixelFormat(format);}
  if(error!=kCGLNoError){[self fail:@"Cannot create the decoded video GPU context."];return;}
  CGLSetCurrentContext(self->_context);int advanced=1;mpv_opengl_init_params gl={glAddress,nullptr};
  mpv_render_param params[]={{MPV_RENDER_PARAM_API_TYPE,(void*)MPV_RENDER_API_TYPE_OPENGL},{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,&gl},{MPV_RENDER_PARAM_ADVANCED_CONTROL,&advanced},{MPV_RENDER_PARAM_INVALID,nullptr}};
  if(self->_api.mpv_render_context_create(&self->_render,self->_mpv,params)<0){[self fail:@"Cannot initialize the decoded video renderer."];return;}
  self->_api.mpv_render_context_set_update_callback(self->_render,updated,(__bridge void*)self);
  [self command:@[@"loadfile",self->_media]];
 }});
}
- (void)command:(NSArray<NSString*>*)arguments {
 if(_closing)return;
 dispatch_async(_events,^{if(self->_closing||!self->_mpv)return;
  std::vector<const char*> values;for(NSString *value in arguments)values.push_back(value.UTF8String);values.push_back(nullptr);
  self->_api.mpv_command_async(self->_mpv,0,values.data());
 });
}
- (void)reportSwap {
 if(_closing)return;
 dispatch_async(_renderQueue,^{if(self->_render&&!self->_closing)self->_api.mpv_render_context_report_swap(self->_render);});
}
- (void)requestEvents {
 if(_closing||_eventScheduled.exchange(true))return;
 dispatch_async(_events,^{self->_eventScheduled=false;if(self->_closing||!self->_mpv)return;
  for(;;){mpv_event *event=self->_api.mpv_wait_event(self->_mpv,0);if(!event||event->event_id==MPV_EVENT_NONE)break;
   if(event->event_id==MPV_EVENT_SHUTDOWN){dispatch_async(dispatch_get_main_queue(),^{[NSApp terminate:nil];});break;}
   if(event->event_id==MPV_EVENT_START_FILE){self->_width=0;self->_height=0;self->_epoch++;}
   if(event->event_id==MPV_EVENT_SEEK)self->_epoch++;
   if(event->event_id==MPV_EVENT_PROPERTY_CHANGE){auto *property=static_cast<mpv_event_property*>(event->data);
    if(property&&property->name&&std::strcmp(property->name,"fullscreen")==0&&property->format==MPV_FORMAT_FLAG&&property->data){
     const bool full=*static_cast<int*>(property->data)!=0;dispatch_async(dispatch_get_main_queue(),^{if(self->_window&&bool(self->_window.styleMask&NSWindowStyleMaskFullScreen)!=full)[self->_window toggleFullScreen:nil];});
    }
   }
   if(event->event_id==MPV_EVENT_VIDEO_RECONFIG||event->event_id==MPV_EVENT_FILE_LOADED){
    int64_t w=0,h=0;self->_api.mpv_get_property(self->_mpv,"dwidth",MPV_FORMAT_INT64,&w);self->_api.mpv_get_property(self->_mpv,"dheight",MPV_FORMAT_INT64,&h);
    if(w>0&&h>0&&w<=16384&&h<=16384){self->_width=(unsigned)w;self->_height=(unsigned)h;[self requestRender];}
   }
  }
 });
}
- (void)resize:(CGSize)size {
 if(size.width<1||size.height<1)return;_layer.drawableSize=size;
 if(_mpv)[self command:@[@"osd-overlay",@"0",@"ass-events",@""]];
}
- (BOOL)createPresenter {
 if(_presenter&&_presenterEpoch==_epoch.load())return YES;
 if(_presenter)_graphics.destroy(_presenter);_presenter=nullptr;_presenterEpoch=_epoch.load();_lastContent={};_producedContent={};_content=0;
 // Owners are opaque registry keys. Never reuse one across a seek; old GPU
 // callbacks retain their own storage while their presentation epoch retires.
 void *owner=reinterpret_cast<void*>(nextPresenterOwner.fetch_add(1));
 RSPresenterOptions options={sizeof(options),1,RS_FRAME_BOTTOM_LEFT,0,0};RSPresenterError error={sizeof(error),1,{}};
 _presenter=_graphics.create((__bridge void*)_layer,owner,&options,&error);
 if(!_presenter){[self fail:[NSString stringWithUTF8String:error.reason]];return NO;}
 _graphics.source(_presenter,RS_FRAME_SOURCE_DECODED_VIDEO);return YES;
}
- (void)requestRender {
 if(_closing||_scheduled.exchange(true))return;
 dispatch_async(_renderQueue,^{self->_scheduled=false;[self pump];});
}
- (void)again {
 if(_timerArmed||_closing)return;_timerArmed=true;
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_MSEC),_renderQueue,^{self->_timerArmed=false;[self pump];});
}
- (void)pump {
 if(_closing||_failed||!_render)return;CGLSetCurrentContext(_context);
 const uint64_t updates=_api.mpv_render_context_update(_render);
 if(updates&MPV_RENDER_UPDATE_FRAME)_framePending=true;
 if(![self createPresenter])return;
 while(!_jobs.empty()) {
  auto job=_jobs.front();auto &slot=_slots[job.slot];if(!slot.surface->ready()){[self again];break;}
  if(job.content.epoch!=_presenterEpoch){slot.busy=false;_jobs.pop_front();continue;}
  id<MTLCommandBuffer> commands=[_commands commandBuffer];
  auto *lease=new SurfaceLease{slot.surface,_renderQueue};
  auto *receipt=new SwapReceipt{self};
  RSPresenterSubmission submission={sizeof(submission),1,(__bridge void*)commands,(__bridge void*)slot.surface->texture(),job.delivery,
    std::max(CACurrentMediaTime(),_lastDeliveryTime+1e-6),lease,releaseSurface};
  RSPresentationTarget target={sizeof(target),1,job.target};
  RSPresentationObserver observer={sizeof(observer),1,receipt,presented};RSFrameResult result={sizeof(result),1};
  const int code=_graphics.submit(_presenter,&submission,&job.content,&target,&observer,&result);
  if(code!=RS_FRAME_OK){delete lease;delete receipt;}
  if(code==RS_FRAME_BUSY){[commands commit];[self again];break;}
  _jobs.pop_front();
  if(code==RS_FRAME_OK){_lastContent=job.content;_lastDeliveryTime=submission.sourceTime;_lastGPUError.clear();}
  else if(_lastGPUError!=result.reason){_lastGPUError=result.reason;fprintf(stderr,"[video] GPU submission: %s\n",result.reason);}
  const unsigned index=job.slot;
  [commands addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_async(self->_renderQueue,^{self->_slots[index].busy=false;[self pump];});}];
  [commands commit];
 }
 if(!_framePending)return;
 if(!_width||!_height){int skip=1,block=0;mpv_render_param params[]={{MPV_RENDER_PARAM_SKIP_RENDERING,&skip},{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,&block},{MPV_RENDER_PARAM_INVALID,nullptr}};_api.mpv_render_context_render(_render,params);_framePending=false;return;}
 auto free=std::find_if(_slots.begin(),_slots.end(),[](const auto &slot){return !slot.busy;});
 if(free==_slots.end())return;
 mpv_render_frame_info info={};_api.mpv_render_context_get_info(_render,{MPV_RENDER_PARAM_NEXT_FRAME_INFO,&info});
 if(!(info.flags&MPV_RENDER_FRAME_INFO_PRESENT)){_framePending=false;return;}
 const bool redraw=(info.flags&(MPV_RENDER_FRAME_INFO_REDRAW|MPV_RENDER_FRAME_INFO_REPEAT))&&(_lastContent.contentId||_content);
 MLMpvFrameMetadata metadata={sizeof(metadata),1};
 const bool exact=_api.mpv_render_context_get_info(_render,{(mpv_render_param_type)ML_MPV_RENDER_PARAM_FRAME_METADATA,&metadata})>=0&&(metadata.flags&ML_MPV_FRAME_PRESENT);
 std::string error;
 if(!free->surface||free->surface->width()!=_width||free->surface->height()!=_height) {
  auto surface=maclauncher::video::GPUSurface::create(_device,_width,_height,false,error);
  if(!surface){[self fail:[NSString stringWithUTF8String:error.c_str()]];return;}free->surface=std::move(surface);
 }
 mpv_opengl_fbo fbo={(int)free->surface->framebuffer(),(int)_width.load(),(int)_height.load(),GL_RGBA8};int block=0,flip=0;
 mpv_render_param params[]={{MPV_RENDER_PARAM_OPENGL_FBO,&fbo},{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,&block},{MPV_RENDER_PARAM_FLIP_Y,&flip},{MPV_RENDER_PARAM_INVALID,nullptr}};
 if(_api.mpv_render_context_render(_render,params)<0){fprintf(stderr,"[video] Decoded GPU rendering failed.\n");return;}
 _framePending=false;
 free->surface->produced();
 if(!redraw)_content++;
 // This is the producer's processing revision, not a per-frame counter.
 // Changing it on every decoded image would reset interpolation history.
 if(!_revision)_revision=1;else if(redraw)++_revision;
 RSPresentationContent content={sizeof(content),1,(uint32_t)((redraw?RS_PRESENT_CONTENT_REDRAW:0)|(!exact||(metadata.flags&ML_MPV_FRAME_PTS_UNKNOWN)?RS_PRESENT_CONTENT_PTS_UNKNOWN:0)),0,
  exact?metadata.contentId:redraw?_producedContent.contentId:_content,_presenterEpoch,_revision,exact?metadata.pts:0,exact?metadata.duration:0};
 const double target=info.target_time>0?_clockOffset+double(info.target_time)*(_api.nanoseconds?1e-9:1e-6):CACurrentMediaTime();
 _producedContent=content;free->busy=true;_jobs.push_back({(unsigned)std::distance(_slots.begin(),free),++_delivery,target,content});[self again];
}
- (void)setFullscreen:(BOOL)full {
 dispatch_async(_events,^{if(!self->_closing&&self->_mpv){int value=full;self->_api.mpv_set_property_async(self->_mpv,2,"fullscreen",MPV_FORMAT_FLAG,&value);}});
}
- (void)windowDidEnterFullScreen:(NSNotification*)notification {(void)notification;[self setFullscreen:YES];}
- (void)windowDidExitFullScreen:(NSNotification*)notification {(void)notification;[self setFullscreen:NO];}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)application {(void)application;return YES;}
- (void)applicationWillTerminate:(NSNotification*)notification {
 (void)notification;_closing=true;
 if(_mpv)_api.mpv_set_wakeup_callback(_mpv,nullptr,nullptr);
 dispatch_sync(_renderQueue,^{
  CGLSetCurrentContext(self->_context);
  if(self->_render){self->_api.mpv_render_context_set_update_callback(self->_render,nullptr,nullptr);self->_api.mpv_render_context_free(self->_render);self->_render=nullptr;}
  if(self->_presenter){self->_graphics.destroy(self->_presenter);self->_presenter=nullptr;}
  self->_jobs.clear();for(auto &slot:self->_slots)slot.surface.reset();
  if(self->_context){CGLSetCurrentContext(nullptr);CGLReleaseContext(self->_context);self->_context=nullptr;}
 });
 dispatch_sync(_events,^{if(self->_mpv){self->_api.mpv_terminate_destroy(self->_mpv);self->_mpv=nullptr;}});
}
@end
int main(int argc,const char **argv) {
 @autoreleasepool {
  setenv("RESHADE_EXPLICIT_HOST","1",1);
  NSMutableArray<NSString*> *arguments=[NSMutableArray array];for(int n=1;n<argc;n++)[arguments addObject:[NSString stringWithUTF8String:argv[n]]];
  if([arguments containsObject:@"--maclauncher-info"]||[arguments containsObject:@"--scale=help"])return inspectLibrary(arguments);
  NSApplication *application=NSApplication.sharedApplication;[application setActivationPolicy:NSApplicationActivationPolicyRegular];
  NSMenu *menu=[NSMenu new],*appMenu=[NSMenu new];NSMenuItem *item=[NSMenuItem new];item.submenu=appMenu;[menu addItem:item];
  [appMenu addItemWithTitle:@"Quit" action:@selector(terminate:) keyEquivalent:@"q"];application.mainMenu=menu;
  NSMenu *view=[NSMenu new];NSMenuItem *viewItem=[NSMenuItem new];viewItem.title=@"View";viewItem.submenu=view;[menu addItem:viewItem];
  NSMenuItem *fullscreen=[view addItemWithTitle:@"Enter Full Screen" action:@selector(toggleFullScreen:) keyEquivalent:@"f"];fullscreen.keyEquivalentModifierMask=NSEventModifierFlagCommand|NSEventModifierFlagControl;
  MLVideoPlayer *player=[[MLVideoPlayer alloc]initWithArguments:arguments];application.delegate=player;[application run];
 }
 return 0;
}
