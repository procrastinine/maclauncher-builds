// SPDX-License-Identifier: GPL-2.0-only
// The converted TLS call uses RAX for both descriptor input and thread-pointer output.
extern "C" void Aps5GuestTlsAllocate_nid_no_patch() {
    auto frame = GuestContext::CaptureCall();
    const auto* descriptor = reinterpret_cast<const GuestTlsDescriptor*>(frame.rax);
    frame.rax = reinterpret_cast<std::uintptr_t>(Aps5GuestTlsAllocateThreadPointer_nid_no_patch(descriptor));
    GuestContext::Restore(frame);
}
