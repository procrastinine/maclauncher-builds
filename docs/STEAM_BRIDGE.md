# Steam client bridge

`maclauncher-steam-bridge` provides Wine builtin `lsteamclient.dll` PE libraries for i386 and x86_64, Mach-O unix libraries for x86_64 and aarch64, Windows launch helpers, and owned bootstrap modules. Steam authentication, login, ownership and ticket responses come from the native Steam client. The package contains no Steam emulator or native Steam application.

The producer fetches Proton sources and the selected NotProton overlay at the exact commits and extracted-file digests in `producers/steam-bridge/source.json`. Wine source and LLVM-MinGW pins reference the existing producer manifests. Assembly occurs in a separate build directory; the payload contains binaries and license notices, with Valve implementation source retained as build inputs.

The native bridge uses Wine's builtin PE/unix loading mechanism and `@rpath/ntdll.so`. Its path-conversion boundary selects the available Wine APIs by exported symbol, supporting both the older Wine 10 buffer APIs and Wine 11 allocation APIs. Runtime distributor names, Steam client builds and binary hashes are not compatibility admission lists. PE bitness and native Wine architecture are selected independently.

The launch helper registers its actual Windows PID and private Steam paths, creates the hidden discovery window, connects real SteamClient/SteamUtils/SteamApps interfaces, and launches the game as its child. It installs a relocation-free bootstrap callback into the suspended child's initial thread before resuming it. The owned module maps the genuine Windows Steam client DLL with `DONT_RESOLVE_DLL_REFERENCES` and redirects its exported API entry points in memory to lsteamclient. Windows Steam initialization and import resolution are suppressed. Unsupported function exports stop the owned process instead of supplying an API result. Neither the genuine DLL nor the game is rewritten on disk, and no installed Wine file is modified.

The callback runs before executable entry; Wine's executable TLS callbacks precede it. A title that initializes Steam in an earlier TLS callback requires an earlier loader integration route. The source pin selects the upstream local DIPC launch acknowledgement. URI dispatch, restart handling, VR setup and anticheat setup are excluded.

Genuine Windows client components are acquired separately from Valve during consented Play delivery. The launcher reads Valve's current public package metadata, selects its content-addressed archive, and verifies that archive against its address. Acquired-file hashes protect the private cache; they are not compared with the installed or running Mac Steam client. Installed-first status and discovery remain offline. The bridge runtime archive does not republish Valve's client DLLs.

Build requirements are macOS 13 or later, the macOS developer tools, Node.js 24.15 or later, Autoconf, Bison, Flex, make, curl, patch and the pinned LLVM-MinGW toolchain. Compilation uses at most two make jobs.

```
node producers/steam-bridge/build.mjs prepare /absolute/build-directory
node producers/steam-bridge/build.mjs build /absolute/build-directory /absolute/llvm-mingw/bin /absolute/new-payload
```

Preparation fetches source inputs into a new build directory. The payload directory must be absent. A sibling runtime-package declaration supports the normal packaging tools. The manifest declares the native modules, PE builtins, bootstrap modules and launch helpers by role for automatic preparation.
