# arm64 library boundary

The overlay applies to the pinned AnyPS5 source projection after the Darwin
runtime overlays. `applyArm64LibrariesOverlay(root)` adds the native build
selection, NID signing, shared guest CPU accessors and standard stream objects.
The configure inputs are `CMAKE_OSX_ARCHITECTURES=arm64` and
`ANYPS5_ARM64_LIBS=ON`. Native dependencies, including FFmpeg, use arm64.
The existing x86_64 selection remains the default.

`copyArm64GuestCpuSources(root)` and `copyArm64StandardStreamObjects(root)`
copy the shared source files into a projection used by a translation host. That
host compiles `GuestCpuArm64.cpp` and `StandardStreamObjects.cpp`. The FEX
GuestCpu patch includes `GuestCpuArm64.hpp` from the same overlay.

## Guest CPU state

`GuestCpuInstallHost_nid_no_patch(const GuestCpu::HostAccessors*)` installs a
complete immutable callback table in libc. The table is copied. Every callback
is required, and installation occurs once before guest code starts. Native PRXs
use `GuestCpuHost_nid_no_patch()` to read that one table. Each callback operates
on the guest state bound to the current host thread.

`ReadTsc`, CPUID and XGETBV describe the selected translator's guest CPU.
MXCSR, its supported mask, the x87 control word, status and environment come
from that guest state. x87 waiting and signaling-NaN handling deliver guest
floating exceptions through the host's guest-exception route.

The x87 environment occupies seven 32-bit words. Guest long double retains
its x87 80-bit representation in 16-byte storage. Apple's native arm64
`long double` uses 64-bit storage and cannot replace that guest format. The
original precision and storage checks remain in the selected libc sources.

## Standard stream data

`StandardStreamObjects.cpp` owns the existing `_Stdin_nid_postfix`,
`_Stdout_nid_postfix` and `_Stderr_nid_postfix` FileStream objects and the
`__stdinp_nid_postfix`, `__stdoutp_nid_postfix` and `__stderrp_nid_postfix`
pointer objects. Their definitions are moved from the original source files,
with the standard stream APIs retained.

A pointer-object import resolves to the address of that exported variable.
Loading its value yields the guest FileStream object. The first 256 bytes of
FileStream contain guest FILE storage; the native FILE handle follows that
storage. Native Darwin FILE objects are not guest FILE objects.

## NID rewriting

arm64 Mach-O libraries are unsigned before NID rewriting and signed ad hoc
afterward. Their export lists retain the selected libc exports. The arm64
unwind selection keeps native compact unwind information.

## Guest contexts and nonlocal transfers

`contexts.mjs` keeps the existing user-context validation and provides arm64
entries for `getcontext`, `setcontext`, `swapcontext`, `setjmp`, `_setjmp`,
`longjmp`, `_longjmp`, `sigsetjmp` and `siglongjmp`. The x86_64 implementations
remain unchanged.

`GuestContextInstallHost_nid_no_patch` copies the two required register capture
and restore callbacks into libc. `GuestContext::RegisterFrame` has the existing
AnyPS5 layout: twenty 64-bit general/control register fields followed by a
512-byte FXSAVE64 image, aligned to 16 bytes. Capture reads the current guest
thread's state. Capture of a guest call saves its return address from the guest
stack and advances the saved stack pointer by eight bytes.

Restore follows the existing x86 implementation: CS and SS stay current, and
only RFLAGS bits in `0x254dd5` change. The legacy FXSAVE image does not replace
upper YMM state. The host must supply the guest's defined floating-point state;
native arm64 registers and fixed default values cannot stand in for it.

After committing a restored frame, the library throws
`GuestContext::Transfer`, carrying the destination instruction and stack
pointers. The translation host catches this control transfer before writing an
ordinary call result or popping a return address. A transfer across nested
native callbacks belongs to the matching guest continuation. Other C++
exceptions retain their normal handling.

The jump-buffer layouts retain their existing distinctions: `setjmp` saves
MXCSR and the x87 control word, `_longjmp` preserves current MXCSR status bits,
and signal jumps save the x87 control word and optional signal mask in their
original fields.
