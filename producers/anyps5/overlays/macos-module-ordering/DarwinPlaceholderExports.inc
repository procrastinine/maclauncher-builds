// SPDX-License-Identifier: GPL-2.0-only
const auto returnsZero = [&](const GuestImage& image, std::uint64_t address) {
    for (const auto& header : image.Headers) {
        if (header.Type != 1 || (header.Flags & 1) == 0 || address < header.MappedAddress || address - header.MappedAddress >= header.FileSize) continue;
        const auto offset = header.Offset + (address - header.MappedAddress);
        const auto available = std::min<std::uint64_t>(header.FileSize - (address - header.MappedAddress), image.Bytes.size() - std::min<std::uint64_t>(offset, image.Bytes.size()));
        const auto matches = [&](const std::vector<std::uint8_t>& code) {
            return code.size() <= available && std::equal(code.begin(), code.end(), image.Bytes.begin() + static_cast<std::ptrdiff_t>(offset));
        };
        return matches({0x31, 0xc0, 0xc3}) || matches({0x66, 0x0f, 0xef, 0xc0, 0x31, 0xc0, 0xc3});
    }
    return false;
};
const auto exportedFunction = [](const auto& symbol) {
    return symbol.Section != 0 && symbol.Section != AbsoluteSection && (symbol.Info >> 4) != 0 && symbol.Visibility != 1 && symbol.Visibility != 2 && (symbol.Info & 15) == 2;
};
std::vector<bool> stubLibrary(images.size(), false);
if (macos) {
    for (std::size_t provider = 0; provider < images.size(); ++provider) {
        bool function = false;
        bool implementations = false;
        for (const auto& symbol : images[provider].Symbols) {
            if (!exportedFunction(symbol)) continue;
            function = true;
            if (!returnsZero(images[provider], symbol.Value)) implementations = true;
        }
        stubLibrary[provider] = function && !implementations;
    }
}
std::set<std::string> placeholderExports;
if (macos) {
    for (const auto& [name, providers] : exports) {
        const bool placeholder = !providers.empty() && std::all_of(providers.begin(), providers.end(), [&](const GuestExport& provider) {
            if (!stubLibrary[provider.Provider]) return false;
            const auto& symbols = images[provider.Provider].Symbols;
            const auto found = std::find_if(symbols.begin(), symbols.end(), [&](const auto& symbol) { return symbol.Name == name && exportedFunction(symbol); });
            return found != symbols.end() && returnsZero(images[provider.Provider], found->Value);
        });
        if (placeholder) placeholderExports.insert(name);
    }
}
