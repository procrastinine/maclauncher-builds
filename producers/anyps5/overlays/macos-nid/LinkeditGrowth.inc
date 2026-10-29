    if (segment.FileOffset + segment.FileSize != binary.size() || oldOffset < segment.FileOffset)
        throw std::runtime_error("linkedit data must belong to the final __LINKEDIT segment");
    const std::uint64_t boundary = std::uint64_t{oldOffset} + oldSize;
    const std::uint64_t growth = (trie.size() - oldSize + 7u) & ~std::uint64_t{7};
    if (growth > 0xffffffffu || binary.size() > 0xffffffffu - growth) throw std::runtime_error("linkedit data offset overflow");
    // Keep each table in its original order relative to the following LINKEDIT
    // tables. Mach-O tools reject an export trie appended after the string table.
    binary.insert(binary.begin() + static_cast<std::ptrdiff_t>(boundary), static_cast<std::size_t>(growth), 0);
    const auto shift32 = [&](std::size_t field) {
        const auto value = Read<std::uint32_t>(binary, field);
        if (value != 0 && value >= boundary) Write(binary, field, static_cast<std::uint32_t>(value + growth));
    };
    for (const auto offset : image.Commands) {
        const auto command = Read<LoadCommand>(binary, offset);
        switch (command.Cmd) {
            case 0x2: // LC_SYMTAB: symbol and string table offsets.
                shift32(offset + 8); shift32(offset + 16); break;
            case 0xb: // LC_DYSYMTAB: offsets alternate with counts after +32.
                for (std::size_t field = 32; field <= 72; field += 8) shift32(offset + field);
                break;
            case kLcDyldInfo: case kLcDyldInfoOnly:
                for (std::size_t field = 8; field <= 40; field += 8) shift32(offset + field);
                break;
            case 0x3: case 0x16: // LC_SYMSEG, LC_TWOLEVEL_HINTS.
            case 0x1e: case 0x26: case 0x29: case 0x2b: case 0x2e:
            case kLcDyldExportsTrie: case kLcDyldChainedFixups:
            case 0x36: case 0x37: case 0x38:
                shift32(offset + 8); break;
            case 0x31: { // LC_NOTE carries a 64-bit file offset.
                const auto value = Read<std::uint64_t>(binary, offset + 24);
                if (value != 0 && value >= boundary) Write(binary, offset + 24, value + growth);
                break;
            }
        }
    }
    std::fill(binary.begin() + oldOffset, binary.begin() + static_cast<std::ptrdiff_t>(boundary + growth), 0);
    std::copy(trie.begin(), trie.end(), binary.begin() + oldOffset);
    segment.FileSize += growth;
    segment.VmSize = std::max(segment.VmSize, (segment.FileSize + kPageSize - 1) & ~(kPageSize - 1));
    Write(binary, *linkedit, segment);
    Write(binary, location.SizeField, static_cast<std::uint32_t>(oldSize + growth));
