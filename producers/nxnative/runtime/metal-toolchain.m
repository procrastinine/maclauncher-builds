#import <Foundation/Foundation.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <mach-o/dyld.h>

static NSString *const ObjectFormat = @"nxnative-metal-source-object-1";

static int fail(NSString *message) {
    fprintf(stderr, "nxnative Metal: %s\n", message.UTF8String); return 1;
}

static NSString *managedRoot(void) {
    return NSProcessInfo.processInfo.environment[@"MCL_APPLE_METAL_TOOLCHAIN_ROOT"];
}

static NSString *targetSDKVersion(void) {
    char executable[PATH_MAX]; uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size)) return nil;
    NSString *root = [[[NSString stringWithUTF8String:executable].stringByResolvingSymlinksInPath stringByDeletingLastPathComponent] stringByDeletingLastPathComponent];
    NSData *bytes = [NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:@"runtime.json"]];
    NSDictionary *runtime = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL] : nil;
    if (![runtime isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *requirements = runtime[@"requirements"];
    if (![requirements isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *compiler = requirements[@"metalCompiler"];
    if (![compiler isKindOfClass:NSDictionary.class]) return nil;
    NSString *version = compiler[@"targetSDKVersion"];
    NSCharacterSet *digits = [NSCharacterSet characterSetWithCharactersInString:@"0123456789."];
    if (![version isKindOfClass:NSString.class] || !version.length || [version rangeOfCharacterFromSet:digits.invertedSet].location != NSNotFound) return nil;
    return version;
}

static NSString *managedTool(NSString *tool) {
    NSString *root = managedRoot();
    if (!root.isAbsolutePath || [root rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound) return nil;
    root = root.stringByResolvingSymlinksInPath;
    NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:[root stringByAppendingPathComponent:@"ToolchainInfo.plist"]];
    NSString *identifier = info[@"Identifier"];
    if (![identifier isKindOfClass:NSString.class] || ![identifier hasPrefix:@"com.apple.dt.toolchain.Metal."]) return nil;
    NSString *file = [root stringByAppendingPathComponent:[@"usr/bin" stringByAppendingPathComponent:tool]];
    if (![file.stringByResolvingSymlinksInPath hasPrefix:[root stringByAppendingString:@"/"]] || ![NSFileManager.defaultManager isExecutableFileAtPath:file]) return nil;
    return file;
}

static NSString *nativeOutput(NSArray<NSString *> *arguments) {
    NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcrun"]; task.arguments = arguments;
    if (managedRoot().length) {
        if (arguments.count < 3 || ![arguments[0] isEqual:@"-sdk"] || ![arguments[1] isEqual:@"macosx"]) return nil;
        BOOL find = [arguments[2] isEqual:@"-find"];
        if (find && arguments.count != 4) return nil;
        NSString *file = managedTool(arguments[find ? 3 : 2]);
        if (!file) return nil;
        if (find) return file;
        task.executableURL = [NSURL fileURLWithPath:file]; task.arguments = [arguments subarrayWithRange:NSMakeRange(3, arguments.count - 3)];
    }
    NSPipe *output = [NSPipe pipe], *errors = [NSPipe pipe]; task.standardOutput = output; task.standardError = errors;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) return nil;
    NSData *bytes = [output.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    if (task.terminationStatus != 0) return nil;
    return [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
}

static BOOL nativeAvailable(void) {
    for (NSString *tool in @[@"metal", @"metallib"]) {
        NSString *location = [nativeOutput(@[@"-sdk", @"macosx", @"-find", tool]) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (!location.length || ![NSFileManager.defaultManager isExecutableFileAtPath:location]) return NO;
    }
    return YES;
}

static int requireNative(void) {
    if (managedRoot().length && !targetSDKVersion()) return fail(@"The selected native tools do not declare a Metal target SDK.");
    return nativeAvailable() ? 0 : fail(managedRoot().length ? @"The selected Apple Metal toolchain is unavailable or invalid." : @"The Apple Metal compiler required for -O1 is unavailable.");
}

static int delegate(int argc, char **argv, NSString *tool) {
    char **forwarded = calloc((size_t)argc + 8, sizeof(char *));
    if (!forwarded) return fail(@"Cannot allocate Metal compiler arguments.");
    NSString *file = managedRoot().length ? managedTool(tool) : @"/usr/bin/xcrun";
    if (!file) { free(forwarded); return fail(@"The selected Apple Metal toolchain is unavailable or invalid."); }
    forwarded[0] = (char *)file.fileSystemRepresentation;
    int first = 1;
    if (managedRoot().length) {
        if (argc > 2 && (!strcmp(argv[first], "-sdk") || !strcmp(argv[first], "--sdk"))) first += 2;
        ++first;
    }
    int count = 1;
    NSString *sdkArgument = nil, *targetArgument = nil;
    if (managedRoot().length && [tool isEqual:@"metal"]) {
        BOOL sysroot = NO, target = NO;
        for (int index = first; index < argc; ++index) {
            if (!strncmp(argv[index], "-isysroot", 9) || !strcmp(argv[index], "--sysroot") || !strncmp(argv[index], "--sysroot=", 10)) sysroot = YES;
            if (!strcmp(argv[index], "-target") || !strcmp(argv[index], "--target") || !strncmp(argv[index], "--target=", 9)) target = YES;
        }
        NSString *root = NSProcessInfo.processInfo.environment[@"SDKROOT"];
        BOOL sdk = root.length && ([NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@"SDKSettings.json"]] || [NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@"SDKSettings.plist"]]);
        if (!sysroot && !sdk) {
            NSString *version = targetSDKVersion();
            if (!version) { free(forwarded); return fail(@"The selected native tools do not declare a Metal target SDK."); }
            sdkArgument = [@"-target-sdk-version=" stringByAppendingString:version];
            forwarded[count++] = "-Xclang"; forwarded[count++] = (char *)sdkArgument.UTF8String;
            if (!target && !NSProcessInfo.processInfo.environment[@"MACOSX_DEPLOYMENT_TARGET"].length) {
                targetArgument = [@"air64-apple-macosx" stringByAppendingString:version];
                forwarded[count++] = "-target"; forwarded[count++] = (char *)targetArgument.UTF8String;
            }
        }
    }
    for (int index = first; index < argc; ++index) forwarded[count++] = argv[index];
    execv(forwarded[0], forwarded);
    const int error = errno; free(forwarded);
    return fail([NSString stringWithFormat:@"Cannot execute the Apple Metal compiler: %s", strerror(error)]);
}

static NSString *identity(void) {
    NSOperatingSystemVersion version = NSProcessInfo.processInfo.operatingSystemVersion;
    NSString *native = [nativeOutput(@[@"-sdk", @"macosx", @"metal", @"--version"]) componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet].firstObject;
    return [NSString stringWithFormat:@"nxnative-metal-source-4 preserve-invariance; native-O1 %@; macOS %ld.%ld.%ld", native.length ? native : @"unavailable", (long)version.majorVersion, (long)version.minorVersion, (long)version.patchVersion];
}

static BOOL writeJSON(NSString *output, id value, NSError **error) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:error];
    return data && [data writeToFile:output options:NSDataWritingAtomic error:error];
}

static BOOL isAir(NSData *data) {
    if (data.length < 4) return NO;
    const unsigned char *bytes = data.bytes;
    return (bytes[0] == 'B' && bytes[1] == 'C' && bytes[2] == 0xc0 && bytes[3] == 0xde) ||
        (bytes[0] == 0xde && bytes[1] == 0xc0 && bytes[2] == 0x17 && bytes[3] == 0x0b);
}

int main(int argc, char **argv) {
    @autoreleasepool {
        NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
        NSUInteger position = 1;
        if (arguments.count == 2 && [arguments[1] isEqual:@"--check-native-metal"]) return requireNative();
        if (arguments.count > 2 && ([arguments[position] isEqual:@"-sdk"] || [arguments[position] isEqual:@"--sdk"])) {
            if (![arguments[position+1] isEqual:@"macosx"]) return fail(@"This managed runtime prepares macOS Metal source libraries.");
            position += 2;
        }
        NSUInteger remaining = arguments.count - position;
        if (remaining == 1 && ([arguments[position] isEqual:@"--show-sdk-version"] || [arguments[position] isEqual:@"--show-sdk-build-version"])) {
            puts(identity().UTF8String); return 0;
        }
        if (remaining == 2 && ([arguments[position] isEqual:@"metal"] || [arguments[position] isEqual:@"metallib"]) && [arguments[position+1] isEqual:@"--version"]) {
            puts(identity().UTF8String); return 0;
        }
        if (!remaining) return fail(@"Specify metal or metallib.");
        NSString *tool = arguments[position++], *output = nil;
        BOOL compile = [tool isEqual:@"metal"];
        if (!compile && ![tool isEqual:@"metallib"]) return fail([@"Unsupported Metal tool: " stringByAppendingString:tool]);
        if (compile && [[arguments subarrayWithRange:NSMakeRange(position, arguments.count - position)] containsObject:@"-O1"])
            return delegate(argc, argv, tool);
        NSMutableArray<NSString *> *sources = [NSMutableArray array];
        NSMutableSet<NSString *> *flags = [NSMutableSet set];
        while (position < arguments.count) {
            NSString *argument = arguments[position++];
            if ([argument isEqual:@"-o"]) {
                if (output) return fail(@"An output may be specified only once.");
                if (position == arguments.count) return fail(@"The output path is missing.");
                output = arguments[position++];
            } else if (compile && ([argument isEqual:@"-c"] || [argument isEqual:@"-O1"] || [argument isEqual:@"-fpreserve-invariance"])) [flags addObject:argument];
            else if ([argument hasPrefix:@"-"]) return fail([@"Unsupported Metal source option: " stringByAppendingString:argument]);
            else [sources addObject:argument];
        }
        if (!output || !sources.count) return fail(@"Specify source files and -o output.");
        NSError *error = nil;
        if (compile) {
            if (sources.count != 1 || ![flags containsObject:@"-c"] || ![flags containsObject:@"-fpreserve-invariance"])
                return fail(@"Metal source objects require one source, -c and -fpreserve-invariance.");
            NSString *source = [NSString stringWithContentsOfFile:sources[0] encoding:NSUTF8StringEncoding error:&error];
            if (!source) return fail(error.localizedDescription);
            if (!writeJSON(output, @{@"format":ObjectFormat,@"name":sources[0].lastPathComponent,@"source":source,@"preserveInvariance":@YES}, &error)) return fail(error.localizedDescription);
        } else {
            NSMutableArray *entries = [NSMutableArray arrayWithCapacity:sources.count];
            NSUInteger air = 0;
            for (NSString *source in sources) {
                NSData *data = [NSData dataWithContentsOfFile:source options:0 error:&error];
                if (!data) return fail(error.localizedDescription);
                if (isAir(data)) { ++air; continue; }
                id item = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
                if (!item) return fail(error.localizedDescription);
                if (![item isKindOfClass:NSDictionary.class] || ![item[@"format"] isEqual:ObjectFormat] || ![item[@"preserveInvariance"] isEqual:@YES] ||
                    ![item[@"source"] isKindOfClass:NSString.class] || ![item[@"name"] isKindOfClass:NSString.class])
                    return fail([@"Invalid Metal source object: " stringByAppendingString:source.lastPathComponent]);
                [entries addObject:@{@"name":item[@"name"],@"source":item[@"source"]}];
            }
            if (air && entries.count) return fail(@"Native AIR and Metal source objects cannot be linked together.");
            if (air) return delegate(argc, argv, tool);
            if (!writeJSON(output, @{@"nxnativeMetalSources":@1,@"sources":entries}, &error)) return fail(error.localizedDescription);
        }
        return 0;
    }
}
