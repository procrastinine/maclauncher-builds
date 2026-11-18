#if defined(__APPLE__)
// Event ring (MACLAUNCHER_EVENT_RING=1): selected runtime-side writes into guest memory and changes to guest
// mappings, recorded with its time, thread, range and writer in a bounded lock-free ring, and dumped in the shared
// format
//   [event-ring] t=<ms> tid=<n> kind=<k> addr=0x.. len=0x.. src=<who> note=<...>
// At a fault, write the retained ring to the .all sidecar. When an allocator word is resolved, also emit its block
// with overlaps marked. At normal exit write the event tail to MACLAUNCHER_EVENT_RING_FILE. Kinds: map, unmap, protect,
// read, import, retire, gpu-writeback, copy, fill, free, alloc, and cpu-store for the first guest CPU store to a
// write-watched page (the write-watch fault). Mapping changes go to a second ring that general traffic never evicts.
// Recording takes no lock and never allocates, so the write-watch fault handler records too. t is milliseconds since
// the ring started; seq in the note orders events with equal t.
namespace {

struct MclRingSample {
    std::uint64_t order, time, begin, bytes, detail, thread;
    const char* kind;
    const char* source;
    const void* caller;
};

struct MclRingEntry {
    std::uint64_t ticket;
    MclRingSample sample;
};

constexpr std::uint64_t MclRingBusy = std::uint64_t{1} << 63;

struct MclRingSet {
    static constexpr std::size_t Size = std::size_t{1} << 22;
    static constexpr std::size_t MapSize = std::size_t{1} << 16;
    static constexpr std::size_t Dumped = std::size_t{1} << 20;
    MclRingEntry* events = nullptr;
    MclRingEntry* maps = nullptr;
    std::atomic<std::uint64_t> next{0};
    std::atomic<std::uint64_t> nextMap{0};
    std::uint64_t start = 0;
    std::atomic<bool> fileWritten{false};
};

std::atomic<MclRingSet*> mclRing{nullptr};

bool MclRingIsMapKind(const char* kind) {
    return kind[0] == 'm' || kind[0] == 'u' || kind[0] == 'p' || kind[0] == 'a' || (kind[0] == 'f' && kind[1] == 'r');
}

template <typename Use>
void MclRingFields(MclRingSample& slot, MclRingSample& sample, Use use) {
    use(slot.order, sample.order);
    use(slot.time, sample.time);
    use(slot.begin, sample.begin);
    use(slot.bytes, sample.bytes);
    use(slot.detail, sample.detail);
    use(slot.thread, sample.thread);
    use(slot.kind, sample.kind);
    use(slot.source, sample.source);
    use(slot.caller, sample.caller);
}

void MclRingRecordIn(MclRingEntry* ring, std::size_t size, std::atomic<std::uint64_t>& next, std::uint64_t order,
    const char* kind, std::uint64_t begin, std::uint64_t bytes, const char* source, std::uint64_t detail, const void* caller) {
    const auto index = next.fetch_add(1, std::memory_order_relaxed);
    auto& entry = ring[index % size];
    auto ticket = std::atomic_ref(entry.ticket);
    auto prior = ticket.load(std::memory_order_acquire);
    if ((prior & MclRingBusy) || prior > index ||
        !ticket.compare_exchange_strong(prior, MclRingBusy | (index + 1), std::memory_order_acq_rel)) return;
    std::uint64_t thread = 0;
    pthread_threadid_np(nullptr, &thread);
    MclRingSample sample{order, clock_gettime_nsec_np(CLOCK_UPTIME_RAW), begin, bytes, detail, thread, kind, source, caller};
    MclRingFields(entry.sample, sample, [](auto& destination, const auto& value) {
        std::atomic_ref(destination).store(value, std::memory_order_release);
    });
    ticket.store(index + 1, std::memory_order_release);
}

bool MclRingRead(MclRingEntry& entry, std::uint64_t index, MclRingSample& sample) {
    const auto ticket = std::atomic_ref(entry.ticket);
    if (ticket.load(std::memory_order_acquire) != index + 1) return false;
    MclRingFields(entry.sample, sample, [](auto& source, auto& value) {
        value = std::atomic_ref(source).load(std::memory_order_acquire);
    });
    return ticket.load(std::memory_order_acquire) == index + 1;
}

constexpr std::uint64_t MclRingClosed = std::uint64_t{1} << 63;
std::atomic<std::uint64_t> mclRingOrder{0};

void MclRingRecord(const char* kind, std::uint64_t begin, std::uint64_t bytes, const char* source, std::uint64_t detail, const void* caller) {
    auto* ring = mclRing.load(std::memory_order_acquire);
    if (ring == nullptr || kind == nullptr || bytes == 0 || bytes > UINT64_MAX - begin) return;
    const int error = errno;
    const auto order = mclRingOrder.fetch_add(1, std::memory_order_relaxed);
    if (order & MclRingClosed) return;
    if (MclRingIsMapKind(kind)) MclRingRecordIn(ring->maps, MclRingSet::MapSize, ring->nextMap, order, kind, begin, bytes, source, detail, caller);
    else MclRingRecordIn(ring->events, MclRingSet::Size, ring->next, order, kind, begin, bytes, source, detail, caller);
    errno = error;
}

void MclRingCaller(const void* pc, char* text, std::size_t size) {
    Dl_info info {};
    if (pc != nullptr && dladdr(pc, &info) != 0 && info.dli_fbase != nullptr) {
        const auto image = reinterpret_cast<std::uintptr_t>(pc) - reinterpret_cast<std::uintptr_t>(info.dli_fbase);
        const char* name = info.dli_fname != nullptr ? std::strrchr(info.dli_fname, '/') : nullptr;
        name = name != nullptr ? name + 1 : info.dli_fname != nullptr ? info.dli_fname : "?";
        if (info.dli_sname != nullptr)
            std::snprintf(text, size, "%s+0x%lx(%s+0x%lx)", info.dli_sname,
                static_cast<unsigned long>(reinterpret_cast<std::uintptr_t>(pc) - reinterpret_cast<std::uintptr_t>(info.dli_saddr)), name, static_cast<unsigned long>(image));
        else
            std::snprintf(text, size, "%s+0x%lx", name, static_cast<unsigned long>(image));
        return;
    }
    std::snprintf(text, size, "%p", pc);
}

int MclRingFormat(const MclRingSet& ring, const MclRingSample& entry, std::uint64_t order, char* text, std::size_t size, const char* extra, bool symbolicate = true) {
    char caller[256] = {};
    if (symbolicate) MclRingCaller(entry.caller, caller, sizeof(caller));
    else std::snprintf(caller, sizeof(caller), "%p", entry.caller);
    const auto time = entry.time >= ring.start ? (entry.time - ring.start) / 1000000 : 0;
    const int length = std::snprintf(text, size, "[event-ring] t=%llu tid=%llu kind=%s addr=0x%llx len=0x%llx src=%s note=seq=%llu detail=0x%llx caller=%s%s\n",
        static_cast<unsigned long long>(time), static_cast<unsigned long long>(entry.thread), entry.kind, static_cast<unsigned long long>(entry.begin),
        static_cast<unsigned long long>(entry.bytes), entry.source != nullptr ? entry.source : "?", static_cast<unsigned long long>(order),
        static_cast<unsigned long long>(entry.detail), caller, extra);
    return length < 0 ? 0 : std::min(length, static_cast<int>(size) - 1);
}

// Walk retained tickets and skip overwritten or still in-flight entries. The timestamp and global sequence
// remain in each record so consumers can order events from simultaneous threads.
struct MclRingWindow {
    std::uint64_t event, lastEvent, map, lastMap;
};
MclRingWindow MclRingCapture(MclRingSet& ring, std::uint64_t limit) {
    const auto lastEvent = ring.next.load(std::memory_order_acquire);
    const auto lastMap = ring.nextMap.load(std::memory_order_acquire);
    auto event = lastEvent > MclRingSet::Size ? lastEvent - MclRingSet::Size : 0;
    const auto map = lastMap > MclRingSet::MapSize ? lastMap - MclRingSet::MapSize : 0;
    if (limit != 0 && lastEvent - event > limit) event = lastEvent - limit;
    return {event, lastEvent, map, lastMap};
}

template <typename Visit>
std::uint64_t MclRingWalk(MclRingSet& ring, MclRingWindow window, Visit visit) {
    auto [event, lastEvent, map, lastMap] = window;
    std::uint64_t scanned = 0;
    while (event < lastEvent || map < lastMap) {
        MclRingSample a{}, b{};
        if (event < lastEvent && !MclRingRead(ring.events[event % MclRingSet::Size], event, a)) { ++event; continue; }
        if (map < lastMap && !MclRingRead(ring.maps[map % MclRingSet::MapSize], map, b)) { ++map; continue; }
        if (map == lastMap || (event < lastEvent && a.order < b.order)) { visit(a, a.order); ++event; }
        else { visit(b, b.order); ++map; }
        ++scanned;
    }
    return scanned;
}

void MclRingWriteFile(MclRingSet& ring, const char* reason, std::uint64_t address) {
    if (ring.fileWritten.exchange(true)) return;
    const char* path = std::getenv("MACLAUNCHER_EVENT_RING_FILE");
    if (path == nullptr || path[0] == '\0') return;
    const int fd = ::open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) return;
    char text[768];
    int length = std::snprintf(text, sizeof(text), "[event-ring-dump] reason=%s address=0x%llx recorded=%llu mappings=%llu capacity=%zu+%zu written=last %zu events and every mapping event\n",
        reason, static_cast<unsigned long long>(address), static_cast<unsigned long long>(ring.next.load()), static_cast<unsigned long long>(ring.nextMap.load()),
        MclRingSet::Size, MclRingSet::MapSize, MclRingSet::Dumped);
    if (length > 0) static_cast<void>(::write(fd, text, static_cast<std::size_t>(length)));
    MclRingWalk(ring, MclRingCapture(ring, MclRingSet::Dumped), [&](const MclRingSample& entry, std::uint64_t order) {
        const int written = MclRingFormat(ring, entry, order, text, sizeof(text), "");
        if (written > 0) static_cast<void>(::write(fd, text, static_cast<std::size_t>(written)));
    });
    ::close(fd);
}

// The whole retained ring after a fault, without symbol lookups and in 1 MiB writes, to "<file>.all".
void MclRingWriteAll(MclRingSet& ring, MclRingWindow window, std::uint64_t cutoff, std::uint64_t faultTime,
                     std::uint64_t effective, std::uint64_t word, const char* id) {
    const char* path = std::getenv("MACLAUNCHER_EVENT_RING_FILE");
    if (path == nullptr || path[0] == '\0') return;
    char name[1024];
    if (std::snprintf(name, sizeof(name), "%s.all", path) >= static_cast<int>(sizeof(name))) return;
    const int fd = ::open(name, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) return;
    static char buffer[1 << 20];
    std::size_t used = 0;
    std::uint64_t written = 0;
    bool ok = true, contiguous = true;
    const auto writeAll = [&](const char* bytes, std::size_t size) {
        while (ok && size != 0) {
            const auto result = ::write(fd, bytes, size);
            if (result < 0 && errno == EINTR) continue;
            if (result <= 0) { ok = false; break; }
            bytes += result;
            size -= static_cast<std::size_t>(result);
        }
    };
    const auto flush = [&] { writeAll(buffer, used); used = 0; };
    char text[768], object[96] {};
    if (word != 0) std::snprintf(object, sizeof(object), " object=0x%llx object_len=0x8", static_cast<unsigned long long>(word));
    const int header = std::snprintf(text, sizeof(text),
        "[event-ring-dump] reason=fault id=%s address=0x%llx scope=all first_seq=0 last_seq=%llu expected=%llu%s\n",
        id, static_cast<unsigned long long>(effective), static_cast<unsigned long long>(cutoff == 0 ? 0 : cutoff - 1),
        static_cast<unsigned long long>(cutoff), object);
    if (header > 0) writeAll(text, static_cast<std::size_t>(header));
    MclRingWalk(ring, window, [&](const MclRingSample& entry, std::uint64_t order) {
        if (!ok || order >= cutoff || entry.time > faultTime) return;
        contiguous = contiguous && order == written;
        const int length = MclRingFormat(ring, entry, order, text, sizeof(text), "", false);
        if (length <= 0) return;
        if (used + static_cast<std::size_t>(length) > sizeof(buffer)) flush();
        if (!ok) return;
        std::memcpy(buffer + used, text, static_cast<std::size_t>(length));
        used += static_cast<std::size_t>(length);
        ++written;
    });
    flush();
    const auto retained = window.lastEvent - window.event + window.lastMap - window.map;
    if (cutoff != 0 && window.event == 0 && window.map == 0 && retained == cutoff && written == cutoff && contiguous) {
        const int done = std::snprintf(text, sizeof(text), "[event-ring-end] id=%s written=%llu\n", id, static_cast<unsigned long long>(written));
        if (done > 0) writeAll(text, static_cast<std::size_t>(done));
    }
    const int summary = std::snprintf(text, sizeof(text), "[event-ring-dump] phase=all-end written=%llu\n", static_cast<unsigned long long>(written));
    if (summary > 0) writeAll(text, static_cast<std::size_t>(summary));
    ::close(fd);
}

void MclRingAtExit() {
    if (auto* ring = mclRing.load(std::memory_order_acquire)) MclRingWriteFile(*ring, "exit", 0);
}

__attribute__((constructor)) void MclRingStart() {
    const char* value = std::getenv("MACLAUNCHER_EVENT_RING");
    if (value == nullptr || value[0] != '1' || value[1] != '\0' || mclRing.load() != nullptr) return;
    static MclRingSet storage;
    auto* ring = &storage;
    mach_vm_address_t events = 0, maps = 0;
    const auto eventBytes = MclRingSet::Size * sizeof(MclRingEntry);
    const auto mapBytes = MclRingSet::MapSize * sizeof(MclRingEntry);
    if (mach_vm_allocate(mach_task_self(), &events, eventBytes, VM_FLAGS_ANYWHERE) != KERN_SUCCESS ||
        mach_vm_allocate(mach_task_self(), &maps, mapBytes, VM_FLAGS_ANYWHERE) != KERN_SUCCESS) {
        if (events != 0) mach_vm_deallocate(mach_task_self(), events, eventBytes);
        std::fprintf(stderr, "[event-ring-dump] could not reserve the ring; recording off\n");
        return;
    }
    // Initialize the ticket and record storage before publishing it to concurrent readers.
    ring->events = new (reinterpret_cast<void*>(events)) MclRingEntry[MclRingSet::Size]{};
    ring->maps = new (reinterpret_cast<void*>(maps)) MclRingEntry[MclRingSet::MapSize]{};
    ring->start = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
    mclRing.store(ring, std::memory_order_release);
    std::atexit(MclRingAtExit);
    std::fprintf(stderr, "[event-ring-dump] recording on: %zu events, %zu mapping events, file %s\n", MclRingSet::Size, MclRingSet::MapSize,
        std::getenv("MACLAUNCHER_EVENT_RING_FILE") != nullptr ? std::getenv("MACLAUNCHER_EVENT_RING_FILE") : "(none)");
}

} // namespace

// One event from any library: kind from the shared list, the guest range, the writer and a detail word.
extern "C" void MclEventRingNote(const char* kind, std::uint64_t begin, std::uint64_t bytes, const char* source, std::uint64_t detail) {
    MclRingRecord(kind, begin, bytes, source, detail, __builtin_return_address(0));
}

extern "C" void MclEventRingDumpObject(std::uint64_t word, std::uint64_t effective) {
    auto* ring = mclRing.load(std::memory_order_acquire);
    if (ring == nullptr) return;
    // One cutoff and capture ID for the raw ring and any operand-bound range.
    const auto cutoff = mclRingOrder.fetch_or(MclRingClosed, std::memory_order_acq_rel);
    if (cutoff & MclRingClosed) return;
    const auto faultTime = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
    const auto window = MclRingCapture(*ring, 0);
    char id[64];
    std::snprintf(id, sizeof(id), "%d-%llu", static_cast<int>(::getpid()), static_cast<unsigned long long>(faultTime));
    if (word == 0 || word > UINT64_MAX - 8) {
        constexpr char note[] = "[event-ring-dump] phase=unresolved reason=fault\n";
        static_cast<void>(::write(STDOUT_FILENO, note, sizeof(note) - 1));
        ring->fileWritten.store(true);
        MclRingWriteAll(*ring, window, cutoff, faultTime, effective, 0, id);
        return;
    }
    constexpr std::size_t Limit = std::size_t{1} << 16;
    constexpr std::uint64_t Block = 0x10000;
    const auto end = word + 8;
    const auto blockBegin = word & ~(Block - 1);
    const auto blockEnd = blockBegin + Block;
    char text[768];
    int fd = -1;
    const char* path = std::getenv("MACLAUNCHER_EVENT_RING_FILE");
    if (path != nullptr && path[0] != '\0' && !ring->fileWritten.exchange(true)) {
        fd = ::open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    }
    bool fileOk = fd >= 0, stdoutOk = true;
    const auto emit = [&](int length) {
        if (length <= 0) return;
        const auto size = std::min(static_cast<std::size_t>(length), sizeof(text) - 1);
        if (fileOk && ::write(fd, text, size) != static_cast<ssize_t>(size)) fileOk = false;
        if (stdoutOk && ::write(STDOUT_FILENO, text, size) != static_cast<ssize_t>(size)) stdoutOk = false;
    };
    emit(std::snprintf(text, sizeof(text),
        "[event-ring-dump] phase=begin reason=fault word=0x%llx bytes=8 block=0x%llx+0x10000 events=%llu:%llu maps=%llu:%llu\n",
        static_cast<unsigned long long>(word), static_cast<unsigned long long>(blockBegin), static_cast<unsigned long long>(window.event),
        static_cast<unsigned long long>(window.lastEvent), static_cast<unsigned long long>(window.map),
        static_cast<unsigned long long>(window.lastMap)));

    static MclRingSample matches[Limit] {};
    std::uint64_t count = 0, hits = 0;
    bool crossedCutoff = false;
    const auto visited = MclRingWalk(*ring, window, [&](const MclRingSample& entry, std::uint64_t) {
        if (entry.order >= cutoff || entry.time > faultTime) { crossedCutoff = true; return; }
        if (entry.begin < blockEnd && blockBegin < entry.begin + entry.bytes) {
            if (entry.begin < end && word < entry.begin + entry.bytes) ++hits;
            matches[count++ % Limit] = entry;
        }
    });
    const auto shown = std::min<std::uint64_t>(count, Limit);
    const auto retained = window.lastEvent - window.event + window.lastMap - window.map;
    // A range can certify filtered gaps only if every ticket through the cutoff was present. Record
    // reservation precedes publication, so compare both cursor totals and the count actually read.
    const bool complete = cutoff != 0 && window.event == 0 && window.map == 0 &&
                          retained == cutoff && visited == retained && !crossedCutoff && shown == count;
    emit(std::snprintf(text, sizeof(text),
        "[event-ring-dump] reason=fault id=%s address=0x%llx scope=range first_seq=0 last_seq=%llu expected=%llu object=0x%llx object_len=0x8 base=0x%llx len=0x10000\n",
        id, static_cast<unsigned long long>(effective), static_cast<unsigned long long>(cutoff != 0 ? cutoff - 1 : 0),
        static_cast<unsigned long long>(count), static_cast<unsigned long long>(word), static_cast<unsigned long long>(blockBegin)));
    // Global sequence is assigned before slot reservation, so concurrent per-ring reservations can arrive out of order.
    std::sort(matches, matches + shown, [](const auto& a, const auto& b) { return a.order < b.order; });
    for (std::uint64_t index = 0; index < shown; ++index) {
        const auto& entry = matches[index];
        const bool hit = entry.begin < end && word < entry.begin + entry.bytes;
        emit(MclRingFormat(*ring, entry, entry.order, text, sizeof(text), hit ? " hit" : "", false));
    }
    if (complete) {
        emit(std::snprintf(text, sizeof(text), "[event-ring-end] id=%s written=%llu\n",
            id, static_cast<unsigned long long>(shown)));
    }
    emit(std::snprintf(text, sizeof(text),
        "[event-ring-dump] phase=end reason=fault word=0x%llx bytes=8 block=0x%llx+0x10000 retained=%llu scanned=%llu unavailable=%llu overwritten=%llu matched=%llu hits=%llu emitted=%llu file=%s\n",
        static_cast<unsigned long long>(word), static_cast<unsigned long long>(blockBegin), static_cast<unsigned long long>(retained),
        static_cast<unsigned long long>(visited), static_cast<unsigned long long>(retained - visited),
        static_cast<unsigned long long>(window.event + window.map), static_cast<unsigned long long>(count), static_cast<unsigned long long>(hits),
        static_cast<unsigned long long>(shown), fileOk ? "writing" : "unavailable"));
    if (fd >= 0) {
        if (::close(fd) != 0) fileOk = false;
        const char* result = fileOk ? "[event-ring-dump] file_complete=1\n" : "[event-ring-dump] file_complete=0\n";
        static_cast<void>(::write(STDOUT_FILENO, result, std::strlen(result)));
    }
    MclRingWriteAll(*ring, window, cutoff, faultTime, effective, word, id);
}
#endif
