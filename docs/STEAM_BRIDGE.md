# Steam client bridge

`maclauncher-steam-bridge` provides Wine builtin `lsteamclient.dll` PE libraries for i386 and x86_64, Mach-O unix libraries for x86_64 and aarch64, a Windows `steam.exe` compatibility helper, and PE export forwarders named `steamclient.dll` and `steamclient64.dll`. Steam authentication and ownership checks belong to the native Steam client. The package contains no native Steam client.

The producer fetches Valve Proton sources and the selected NotProton overlay at the commits and extracted-file digests in `producers/steam-bridge/source.json`. Wine source and LLVM-MinGW pins reference the existing producer manifests. Source assembly occurs in a separate build directory. The package contains binary outputs and license notices; Valve implementation source remains in the build inputs.

The unix libraries use the CrossOver 26.3 Wine 11.0 source ABI. Game PE bitness and Wine's native execution architecture are independent. The aarch64 unix library is intended for an arm64 Wine host; the x86_64 unix library requires an x86_64 Wine host. A successful build alone does not establish compatibility with a particular installed runtime.

Build requirements are macOS 13 or later, the macOS developer tools, Node.js 24.15 or later, Autoconf, Bison, Flex, make, curl, patch, and the pinned LLVM-MinGW macOS toolchain. Native compilers resolve through `xcrun`; PE compilation uses the supplied LLVM-MinGW directory. Compilation uses at most two make jobs.

```
node producers/steam-bridge/build.mjs prepare /absolute/build-directory
node producers/steam-bridge/build.mjs build /absolute/build-directory /absolute/llvm-mingw/bin /absolute/new-payload
```

Preparation requires a new build directory and network access. A completed prepared directory can be used by the build command. The payload directory is immutable and must be absent. A sibling `new-payload-runtime-package.json` declares the payload files for the normal runtime packaging tools.

Wine selects the paired builtin libraries through `WINEDLLPATH`. The forwarders belong in the launch environment's private Steam directory; exported functions forward to `lsteamclient`. Existing prefixes also require the package-owned builtin PE files at `windows/system32/lsteamclient.dll` (x86_64) and `windows/syswow64/lsteamclient.dll` (i386), so Wine discovers the builtin outside prefix bootstrap. Wine resolves their unix halves through the private `WINEDLLPATH` directory. The `steam.exe` helper sets the prefix-local Steam discovery registry values and launches a child process. `SteamAppId` and `SteamGameId` identify the game, and `STEAM_COMPAT_CLIENT_INSTALL_PATH` identifies the directory containing the native `steamclient.dylib`. Starting Steam requires separate consent through the launcher's network consent flow.

The producer neither patches Wine's loader nor installs files into CrossOver or Steam. It includes no client injection component or Steam settings modification. No application integration is provided by this producer.

The forwarders contain a zero-initialized writable `.data` arena for upstream interface allocation. Its size is generated from the pinned allocator slot limit and largest generated vtable, using the widest supported pointer size, two times headroom and page rounding. Initialized file bytes are retained because the upstream allocator bounds the arena with the section's `SizeOfRawData`. Export names, ordinals and forwarding targets remain those of the built lsteamclient DLL.

The compatibility helper runs from the prefix Steam directory as the child game's parent. It registers its own Windows PID and the private client DLL paths, creates the hidden Steam discovery window, and initializes SteamClient017, SteamUtils009 and SteamApps008 through the real client bridge. Failed native-client initialization prevents child launch. Its direct process-launch path preserves the argument vector and waits for the child to exit. The source pin selects whether the upstream DIPC launch acknowledgement and its prefix-local named events/semaphores are included. This launch acknowledgement is local; client authentication, login and ownership responses still come from the native Steam client. URI dispatch, restart handling, VR setup and anticheat setup are excluded.
