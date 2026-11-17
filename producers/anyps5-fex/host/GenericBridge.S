// SPDX-License-Identifier: GPL-2.0-only
// The generic register shim the per-signature thunks replace, for the proof's fail-first run: guest rdi-r9 in x0-x5,
// guest stack arguments 7 and 8 in x6 and x7, xmm0-xmm7 in d0-d7; x0/x1 and d0/d1 come back as rax/rdx and xmm0/xmm1.
// x8 points at a scratch area so a wrong indirect-result call cannot write host memory.
//   void GenericBridge(BridgeRegisters* Registers, const void* Export, void* Scratch)
// BridgeRegisters: X[8] at 0, D[8] at 64, OutX[2] at 128, OutD[2] at 144.
    .text
    .globl _GenericBridge
    .p2align 2
_GenericBridge:
    stp x29, x30, [sp, #-32]!
    mov x29, sp
    str x19, [sp, #16]
    mov x19, x0
    mov x16, x1
    mov x8, x2
    ldp d0, d1, [x19, #64]
    ldp d2, d3, [x19, #80]
    ldp d4, d5, [x19, #96]
    ldp d6, d7, [x19, #112]
    ldp x0, x1, [x19, #0]
    ldp x2, x3, [x19, #16]
    ldp x4, x5, [x19, #32]
    ldp x6, x7, [x19, #48]
    blr x16
    stp x0, x1, [x19, #128]
    stp d0, d1, [x19, #144]
    ldr x19, [sp, #16]
    ldp x29, x30, [sp], #32
    ret
