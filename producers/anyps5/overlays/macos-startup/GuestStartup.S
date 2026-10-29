.text
.globl _Aps5GuestTlsAllocate_nid_no_patch
_Aps5GuestTlsAllocate_nid_no_patch:
    .cfi_startproc
    pushfq
    .cfi_adjust_cfa_offset 8
    pushq %rbp
    .cfi_adjust_cfa_offset 8
    .cfi_offset %rbp, -24
    movq %rsp, %rbp
    .cfi_def_cfa %rbp, 24
    cld
    pushq %rbx
    .cfi_offset %rbx, -32
    pushq %rcx
    pushq %rdx
    pushq %rsi
    pushq %rdi
    pushq %r8
    pushq %r9
    pushq %r10
    pushq %r11
    pushq %r12
    .cfi_offset %r12, -104
    pushq %r13
    .cfi_offset %r13, -112
    pushq %r14
    .cfi_offset %r14, -120
    pushq %r15
    .cfi_offset %r15, -128
    movq %rax, %r12
    movl _Aps5GuestVectorState_nid_no_patch+8(%rip), %ecx
    addq $63, %rcx
    subq %rcx, %rsp
    andq $-64, %rsp
    cmpl $0, _Aps5GuestVectorState_nid_no_patch+12(%rip)
    je 1f
    movq %rsp, %rdi
    movl _Aps5GuestVectorState_nid_no_patch+8(%rip), %ecx
    shrq $3, %rcx
    xorl %eax, %eax
    rep stosq
    movq _Aps5GuestVectorState_nid_no_patch(%rip), %rax
    movq %rax, %rdx
    shrq $32, %rdx
    xsave64 (%rsp)
    jmp 2f
1:
    fxsave64 (%rsp)
2:
    movq %r12, %rdi
    callq _Aps5GuestTlsAllocateThreadPointer_nid_no_patch
    movq %rax, %r13
    cmpl $0, _Aps5GuestVectorState_nid_no_patch+12(%rip)
    je 3f
    movq _Aps5GuestVectorState_nid_no_patch(%rip), %rax
    movq %rax, %rdx
    shrq $32, %rdx
    xrstor64 (%rsp)
    jmp 4f
3:
    fxrstor64 (%rsp)
4:
    movq %r13, %rax
    leaq -104(%rbp), %rsp
    popq %r15
    popq %r14
    popq %r13
    popq %r12
    popq %r11
    popq %r10
    popq %r9
    popq %r8
    popq %rdi
    popq %rsi
    popq %rdx
    popq %rcx
    popq %rbx
    popq %rbp
    .cfi_def_cfa %rsp, 16
    popfq
    .cfi_adjust_cfa_offset -8
    retq
    .cfi_endproc

.globl _Aps5CallGuestProcessEntry_nid_no_patch
_Aps5CallGuestProcessEntry_nid_no_patch:
    .cfi_startproc
    pushq %rbp
    .cfi_adjust_cfa_offset 8
    .cfi_offset %rbp, -16
    pushq $0
    .cfi_adjust_cfa_offset 8
    pushq $0
    .cfi_adjust_cfa_offset 8
    movq %rsp, %rbp
    movq %rdi, %rax
    movq %rsi, %rdi
    movq %rdx, %rsi
    xorl %edx, %edx
    callq *%rax
    addq $16, %rsp
    .cfi_adjust_cfa_offset -16
    popq %rbp
    .cfi_adjust_cfa_offset -8
    retq
    .cfi_endproc
