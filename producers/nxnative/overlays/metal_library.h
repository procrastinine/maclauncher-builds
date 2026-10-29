#pragma once
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

id<MTLLibrary> nxnative_metal_library(id<MTLDevice> device, NSString *path, NSError **error);
id<MTLLibrary> nxnative_metal_library_data(id<MTLDevice> device, NSData *data, NSError **error);
