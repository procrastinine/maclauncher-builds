struct GuestVectorState {
    std::uint64_t mask;
    std::uint32_t size;
    std::uint32_t useXsave;
};

GuestVectorState VectorState() {
    unsigned eax, ebx, ecx, edx;
    if (__get_cpuid_max(0, nullptr) < 0xd) return {0, 512, 0};
    __cpuid_count(1, 0, eax, ebx, ecx, edx);
    if ((ecx & (3u << 26)) != (3u << 26)) return {0, 512, 0};
    asm volatile("xgetbv" : "=a"(eax), "=d"(edx) : "c"(0));
    const auto enabled = (std::uint64_t{edx} << 32) | eax;
    __cpuid_count(0xd, 0, eax, ebx, ecx, edx);
    const auto supported = (std::uint64_t{edx} << 32) | eax;
    if ((enabled & supported & 3) != 3 || ebx < 576 || ebx > 0x100000) Fail("unsupported vector state layout");
    return {enabled & supported, (ebx + 63u) & ~63u, 1};
}

extern "C" std::uintptr_t __stack_chk_guard_nid_postfix;
constexpr std::size_t AllocationKeySlot = AllocationSlot - sizeof(pthread_key_t);
struct TlsKeyState {
    const mach_header* image;
    std::size_t allocations = 0;
    bool retired = false;
};
auto& TlsKeys() { static auto* keys = new std::map<pthread_key_t,TlsKeyState>; return *keys; }
auto& TlsMutex() { static auto* mutex = new std::mutex; return *mutex; }
void Release(void* threadPointer);

void ValidateDescriptor(const GuestTlsDescriptor* descriptor) {
    if (!descriptor || descriptor->version != 1 || !std::has_single_bit(descriptor->alignment) ||
        descriptor->blockSize % descriptor->alignment != 0 || descriptor->templateSize > descriptor->blockSize ||
        (descriptor->templateSize && !descriptor->templateAddress) ||
        descriptor->blockSize > std::numeric_limits<std::size_t>::max() - ThreadControlBlockBytes)
        Fail("invalid TLS descriptor layout");
}

void ReleaseBlock(void* threadPointer) {
    if (!threadPointer) return;
    auto* bytes = static_cast<std::uint8_t*>(threadPointer);
    pthread_key_t key;
    std::memcpy(&key,bytes + AllocationKeySlot,sizeof(key));
    {
        std::lock_guard lock(TlsMutex());
        const auto found = TlsKeys().find(key);
        if (found == TlsKeys().end() || found->second.allocations == 0) Fail("unregistered TLS allocation");
        if (--found->second.allocations == 0 && found->second.retired) {
            if (pthread_key_delete(key) != 0) Fail("cannot retire a TLS key");
            TlsKeys().erase(found);
        }
    }
    std::free(*reinterpret_cast<void**>(bytes + AllocationSlot));
}

void RetireTlsImage(const mach_header* image,std::intptr_t) noexcept {
    try {
        std::vector<void*> current;
        {
            std::lock_guard lock(TlsMutex());
            for (auto at = TlsKeys().begin(); at != TlsKeys().end();) {
                if (at->second.image != image) { ++at; continue; }
                at->second.retired = true;
                if (auto* pointer = pthread_getspecific(at->first)) {
                    if (pthread_setspecific(at->first,nullptr) != 0) Fail("cannot detach retiring TLS");
                    current.push_back(pointer);
                }
                if (at->second.allocations == 0) {
                    if (pthread_key_delete(at->first) != 0) Fail("cannot retire a TLS key");
                    at = TlsKeys().erase(at);
                } else ++at;
            }
        }
        for (auto* pointer : current) ReleaseBlock(pointer);
    } catch (...) { std::abort(); }
}
const bool tlsRemovalObserver = [] { _dyld_register_func_for_remove_image(RetireTlsImage); return true; }();

pthread_key_t RegisterTlsKey(GuestTlsDescriptor* descriptor) {
    ValidateDescriptor(descriptor);
    std::lock_guard lock(TlsMutex());
    auto key = std::atomic_ref(descriptor->key).load(std::memory_order_acquire);
    if (key == 0) {
        pthread_key_t allocated;
        if (pthread_key_create(&allocated,Release) != 0) Fail("cannot create a thread pointer key");
        if (allocated == 0) { pthread_key_delete(allocated); Fail("TLS key overlaps a Darwin thread slot"); }
        Dl_info owner{};
        const auto* image = dladdr(descriptor,&owner) ? static_cast<const mach_header*>(owner.dli_fbase) : nullptr;
        try { TlsKeys().emplace(allocated,TlsKeyState{image}); }
        catch (...) { pthread_key_delete(allocated); throw; }
        key = allocated;
        std::atomic_ref(descriptor->key).store(key,std::memory_order_release);
    }
    if (key > std::numeric_limits<pthread_key_t>::max()) Fail("invalid TLS key");
    const auto found = TlsKeys().find(static_cast<pthread_key_t>(key));
    if (found == TlsKeys().end() || found->second.retired) Fail("TLS module is unloaded");
    return static_cast<pthread_key_t>(key);
}

void RecordTlsAllocation(const GuestTlsDescriptor* descriptor,void* threadPointer) {
    const auto key = static_cast<pthread_key_t>(descriptor->key);
    auto* bytes = static_cast<std::uint8_t*>(threadPointer);
    std::memcpy(bytes + AllocationKeySlot,&key,sizeof(key));
    std::memcpy(bytes + 0x28,&__stack_chk_guard_nid_postfix,sizeof(__stack_chk_guard_nid_postfix));
    std::lock_guard lock(TlsMutex());
    const auto found = TlsKeys().find(key);
    if (found == TlsKeys().end() || found->second.retired) Fail("TLS module is unloaded");
    ++found->second.allocations;
}
