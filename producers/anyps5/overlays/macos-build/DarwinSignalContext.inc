void FromHost(const mcontext_t& host, GuestMcontext& m) {
    const auto& registers = host->__ss;
    m.rdi = registers.__rdi;
    m.rsi = registers.__rsi;
    m.rdx = registers.__rdx;
    m.rcx = registers.__rcx;
    m.r8 = registers.__r8;
    m.r9 = registers.__r9;
    m.rax = registers.__rax;
    m.rbx = registers.__rbx;
    m.rbp = registers.__rbp;
    m.r10 = registers.__r10;
    m.r11 = registers.__r11;
    m.r12 = registers.__r12;
    m.r13 = registers.__r13;
    m.r14 = registers.__r14;
    m.r15 = registers.__r15;
    m.rip = registers.__rip;
    m.rsp = registers.__rsp;
    m.rflags = registers.__rflags;
    m.cs = registers.__cs;
    m.fs = static_cast<std::uint16_t>(registers.__fs);
    m.gs = static_cast<std::uint16_t>(registers.__gs);
    std::uint16_t stackSegment;
    __asm__ volatile("movw %%ss, %0" : "=r"(stackSegment));
    m.ss = stackSegment;
    m.trapno = host->__es.__trapno;
    m.err = host->__es.__err;
    m.addr = host->__es.__faultvaddr;
    m.len = sizeof(GuestMcontext);
    static_assert(offsetof(_STRUCT_X86_FLOAT_STATE64, __fpu_xmm0) - offsetof(_STRUCT_X86_FLOAT_STATE64, __fpu_fcw) == 160);
    static_assert(offsetof(_STRUCT_X86_FLOAT_STATE64, __fpu_xmm15) + 16 - offsetof(_STRUCT_X86_FLOAT_STATE64, __fpu_fcw) == FxsaveRegisterBytes);
    std::memcpy(m.fpstate, &host->__fs.__fpu_fcw, FxsaveRegisterBytes);
    const auto* native = reinterpret_cast<const unsigned char*>(&host->__fs.__fpu_fcw);
    auto* guest = reinterpret_cast<unsigned char*>(m.fpstate);
    std::uint16_t status;
    std::memcpy(&status, native + 2, sizeof(status));
    const unsigned top = (status >> 11) & 7;
    // Darwin stores physical x87 registers; FXSAVE stores logical ST(i).
    // The abridged tag word still describes physical registers in both ABIs.
    for (unsigned index = 0; index < 8; ++index)
        std::memcpy(guest + 32 + index * 16, native + 32 + ((top + index) & 7) * 16, 10);
}

void ToHost(const GuestMcontext& m, mcontext_t& host) {
    auto& registers = host->__ss;
    registers.__rdi = m.rdi;
    registers.__rsi = m.rsi;
    registers.__rdx = m.rdx;
    registers.__rcx = m.rcx;
    registers.__r8 = m.r8;
    registers.__r9 = m.r9;
    registers.__rax = m.rax;
    registers.__rbx = m.rbx;
    registers.__rbp = m.rbp;
    registers.__r10 = m.r10;
    registers.__r11 = m.r11;
    registers.__r12 = m.r12;
    registers.__r13 = m.r13;
    registers.__r14 = m.r14;
    registers.__r15 = m.r15;
    registers.__rip = m.rip;
    registers.__rsp = m.rsp;
    registers.__rflags = m.rflags;
    auto* native = reinterpret_cast<unsigned char*>(&host->__fs.__fpu_fcw);
    const auto* guest = reinterpret_cast<const unsigned char*>(m.fpstate);
    std::uint16_t status;
    std::memcpy(&status, guest + 2, sizeof(status));
    const unsigned top = (status >> 11) & 7;
    std::memcpy(native, guest, 32);
    std::memcpy(native + 160, guest + 160, 256);
    for (unsigned index = 0; index < 8; ++index)
        std::memcpy(native + 32 + ((top + index) & 7) * 16, guest + 32 + index * 16, 10);
}
