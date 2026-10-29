        const auto generation = GuestAllocations::GuestAllocationsGeneration_nid_postfix();
        const auto access = pages.accessSerial.load(std::memory_order_acquire);
        mach_vm_address_t region = cursor;
        mach_vm_size_t regionBytes = 0;
        vm_region_basic_info_data_64_t info{};
        mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object = MACH_PORT_NULL;
        const auto result = mach_vm_region(mach_task_self(), &region, &regionBytes, VM_REGION_BASIC_INFO_64, reinterpret_cast<vm_region_info_t>(&info), &count, &object);
        if (object != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), object);
        if (result == KERN_INVALID_ADDRESS) {
            static_cast<void>(emit(PageRun{cursor, end, false, false}));
            return true;
        }
        if (result != KERN_SUCCESS || regionBytes == 0 || regionBytes > std::numeric_limits<std::uintptr_t>::max() - region) return false;
        const auto regionEnd = static_cast<std::uintptr_t>(region + regionBytes);
        if (regionEnd <= cursor) return false;
        auto next = std::min(end, region > cursor ? static_cast<std::uintptr_t>(region) : regionEnd);
        int protection = region > cursor ? PROT_NONE : info.protection;
        std::uintptr_t watchedEnd = next;
        const int logicalProtection = GuestWriteWatch::GuestWriteWatchProtection_nid_postfix(cursor, next, &watchedEnd);
        if (logicalProtection >= 0) {
            protection = logicalProtection;
            next = std::min(next, watchedEnd);
        }
        if (next <= cursor) return false;
        const bool readable = (protection & PROT_READ) != 0;
        const bool writable = readable && (protection & PROT_WRITE) != 0;
        constexpr auto mask = static_cast<std::uintptr_t>(PageBytes - 1);
        pages.record(cursor & ~mask, (next + mask) & ~mask, readable, writable, generation, access);
        if (!emit(PageRun{cursor, next, readable, writable})) return true;
        cursor = next;
