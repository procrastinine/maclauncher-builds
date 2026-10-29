extern "C" void __cxa_finalize(void* image);
extern "C" [[noreturn]] void LibcExit_nid_no_patch(int code);
extern "C" int Aps5CallGuestProcessEntry_nid_no_patch(void* entry,const void* block,void (*callback)());
thread_local bool guestMainThread = false;

void FinalizeGuestImages() {
    std::vector<const mach_header_64*> images;
    for (std::uint32_t index = 0; index < _dyld_image_count(); ++index) {
        const auto* image = reinterpret_cast<const mach_header_64*>(_dyld_get_image_header(index));
        if (!image || image->magic != MH_MAGIC_64 || (image->flags & MH_DYLIB_IN_CACHE)) continue;
        unsigned long size = 0;
        const auto* meta = getsectiondata(image,"__APS5DATA","__meta",&size);
        std::uint64_t version = 0;
        if (meta && size >= 0x60) std::memcpy(&version,meta,sizeof(version));
        if (version == 2) images.push_back(image);
    }
    for (auto at = images.rbegin(); at != images.rend(); ++at) __cxa_finalize(const_cast<mach_header_64*>(*at));
}

struct MainInvocation {
    void (*function)(void*);
    void* context;
    std::exception_ptr error;
};
void InvokeMain(void* context) noexcept {
    auto& invocation = *static_cast<MainInvocation*>(context);
    try { invocation.function(invocation.context); }
    catch (...) { invocation.error = std::current_exception(); }
}
