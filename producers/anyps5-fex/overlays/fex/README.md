# Darwin FEXCore overlay

The patches apply in numeric order to the FEX source selected by the producer's gitlink. The core patch accepts Darwin as an embedding target and builds `Source/Common`; the embedding host supplies its executable target.

`0001-darwin-core.patch` adapts the platform boundary, executable allocation, per-thread JIT writes and the register allocator's reserved x18. `0002-darwin-code-guards.patch` sizes guards to the host page and replaces the final owned MAP_JIT page with an ordinary inaccessible mapping. Temporary emission buffers remain ordinary writable mappings with a host-page guard.

`0003-darwin-signals-and-guest-state.patch` provides header-only embedding interfaces:

- `FEXCore/Darwin/SignalDelegator.h`: process signal installation, unaligned atomic backpatching, guest code-write faults and guest exception delivery from Darwin arm64 contexts.
- `FEXCore/Darwin/GuestState.h`: a scoped current guest thread and a template that fills the embedding library's CPU accessor table from FEX state.

The embedding host installs the delegator before starting guest threads, and joins those threads before uninstalling it. Each OS thread binds its guest with `FEXCore::Darwin::ThreadScope` while executing translated code and native guest-library calls. Mapping callbacks supply stable guest permissions and distinguish code-write traps from read-only guest mappings. Invalidation covers all guest threads and shared aliases before the delegator restores write access. Exception callbacks select a guest continuation by editing the spilled guest state. An unmasked floating-point exception in a native guest-library call uses the host's non-returning floating-point exception continuation.

Only owned complete host pages may be unprotected. Native faults and guest mappings that do not satisfy the code-write contract pass to the previous signal handler with its reported mask and restart flags. A previous one-shot disposition can only be preserved when Darwin reports it. The host supplies an alternate signal stack for each guest thread. The Darwin host does not enable SVE or fault-free synchronous dispatch without the corresponding host context support.

The CPU accessors reflect the selected FEXCore representation. The MXCSR write mask is the mask emitted by its FXSAVE implementation. The x87 environment carries FEX's control word, status, physical register tags and instruction pointer; data pointers, selectors and FOP require additional core state. Full 80-bit x87 arithmetic and software x86 memory ordering remain enabled.

`0004-darwin-context-state.patch` supplies `FEXCore/Darwin/ContextState.h`. `InstallContextAccessors<Frame>(table)` binds the embedding library's Capture/Restore table to the current guest thread. Capture records the raw guest entry state in its named registers and FXSAVE64 image; the guest library owns adjustments to saved call continuations. Restore retains current CS/SS, merges the user-changeable RFLAGS bits, restores register and floating-point state and resets FEX's return prediction stack. Upper YMM halves retain their current values during legacy FX restore. The host's control-transfer mechanism resumes execution without applying an ordinary native-call result or RET. FOP and FDP remain unavailable in the selected core representation.

`0005-darwin-single-step-writes.patch` opens the same scoped JIT write mode for single-instruction compilation as ordinary block compilation. This covers the code publication used when resuming a self-modifying instruction or the guest trap flag.

`0006-x87-status.patch` preserves the x87 exception-status bits across environment restoration, status reads, FNCLEX and FNINIT. `0007-precise-memory-pop.patch` commits RSP after a memory POP store succeeds, while retaining the post-incremented address calculation for RSP-relative destinations.

The overlay is MIT-licensed. The core platform patch derives from the existing Darwin adaptation in this producer. Signal state reconstruction follows FEX's MIT Linux frontend, `Source/Tools/LinuxEmulation/LinuxSyscalls/SignalDelegator.cpp` and `SyscallsSMCTracking.cpp`. Existing FEX copyright and license notices remain in the selected source. The Darwin context and mapping code is an independent implementation and has no Wine dependency.

The x87 status change is by Avery Felts from the MetalSharp-Wine FEX series. The memory POP change is by Alexander Theißen from the Mach9 FEX fork. Both retain their original authorship, MIT license, source commit and origin in the patch metadata; the x87 adaptation includes only the generic FEXCore changes.
