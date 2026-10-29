#import "metal_library.h"

@interface NxNativeMetalLibraries : NSProxy {
    NSArray<id<MTLLibrary>> *_libraries;
}
- (instancetype)initWithLibraries:(NSArray<id<MTLLibrary>> *)libraries;
@end

@implementation NxNativeMetalLibraries
- (instancetype)initWithLibraries:(NSArray<id<MTLLibrary>> *)libraries {
    _libraries = [libraries copy]; return self;
}
- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector {
    return [(NSObject *)_libraries.firstObject methodSignatureForSelector:selector];
}
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [_libraries.firstObject respondsToSelector:selector];
}
- (BOOL)conformsToProtocol:(Protocol *)protocol {
    return [_libraries.firstObject conformsToProtocol:protocol];
}
- (NSArray<NSString *> *)functionNames {
    NSMutableOrderedSet *names = [NSMutableOrderedSet orderedSet];
    for (id<MTLLibrary> library in _libraries) [names addObjectsFromArray:library.functionNames];
    return names.array;
}
- (void)forwardInvocation:(NSInvocation *)invocation {
    id<MTLLibrary> selected = _libraries.firstObject;
    NSString *selector = NSStringFromSelector(invocation.selector);
    if ([selector hasPrefix:@"newFunctionWith"] || [selector hasPrefix:@"newIntersectionFunctionWith"]) {
        __unsafe_unretained id argument = nil;
        [invocation getArgument:&argument atIndex:2];
        NSString *name = [argument isKindOfClass:NSString.class] ? argument : [argument respondsToSelector:@selector(name)] ? [argument name] : nil;
        for (id<MTLLibrary> library in _libraries) if ([library.functionNames containsObject:name]) { selected = library; break; }
    }
    [invocation invokeWithTarget:selected];
}
@end

static void fail(NSError **error, NSString *message) {
    if (error) *error = [NSError errorWithDomain:@"nxnative.metal" code:1 userInfo:@{NSLocalizedDescriptionKey:message}];
}

id<MTLLibrary> nxnative_metal_library_data(id<MTLDevice> device, NSData *data, NSError **error) {
    if (data.length >= 4 && !memcmp(data.bytes, "MTLB", 4)) {
        dispatch_data_t bytes = dispatch_data_create(data.bytes, data.length, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ (void)data; });
        return [device newLibraryWithData:bytes error:error];
    }
    id package = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
    if (![package isKindOfClass:NSDictionary.class] || ![package[@"nxnativeMetalSources"] isEqual:@1] || ![package[@"sources"] isKindOfClass:NSArray.class] || ![package[@"sources"] count]) {
        fail(error, @"Invalid Metal source package."); return nil;
    }
    NSMutableArray<id<MTLLibrary>> *libraries = [NSMutableArray array];
    MTLCompileOptions *options = [MTLCompileOptions new]; options.preserveInvariance = YES;
    for (id item in package[@"sources"]) {
        if (![item isKindOfClass:NSDictionary.class] || ![item[@"source"] isKindOfClass:NSString.class]) {
            fail(error, @"Invalid Metal source entry."); return nil;
        }
        id<MTLLibrary> library = [device newLibraryWithSource:item[@"source"] options:options error:error];
        if (!library) return nil;
        [libraries addObject:library];
    }
    return libraries.count == 1 ? libraries.firstObject : (id<MTLLibrary>)[[NxNativeMetalLibraries alloc] initWithLibraries:libraries];
}

id<MTLLibrary> nxnative_metal_library(id<MTLDevice> device, NSString *path, NSError **error) {
    NSData *data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:error];
    return data ? nxnative_metal_library_data(device, data, error) : nil;
}
