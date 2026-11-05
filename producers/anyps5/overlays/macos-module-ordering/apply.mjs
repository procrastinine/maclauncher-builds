// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';
import {edit} from '../macos-aborts/apply.mjs';
export function applyModuleOrderingOverlay(root) {
  const relative = 'core/relinker/relinker/src/guest/GuestModuleBuilder.cpp';
  const helper = 'core/relinker/relinker/src/guest/DarwinPlaceholderExports.inc';
  fs.copyFileSync(path.join(import.meta.dirname, 'DarwinPlaceholderExports.inc'), path.join(root, helper));
  edit(root, relative, [
    [`    const auto declaresHost = [&](const std::string& library) { return !windows && !library.empty() && findGuest(library) == guestNames.end(); };`, `#ifdef __APPLE__
#include "DarwinPlaceholderExports.inc"
#endif
    const auto declaresHost = [&](const std::string& library, const std::string& name) {
#ifdef __APPLE__
        return !windows && (!macos || placeholderExports.contains(name)) && !library.empty() && findGuest(library) == guestNames.end();
#else
        (void)name;
        return !windows && !library.empty() && findGuest(library) == guestNames.end();
#endif
    };`],
    [`        if (declaresHost(executableModules[offset / 24])) continue;
        const std::string base = name.substr(0, name.find('#'));`, `        const std::string base = name.substr(0, name.find('#'));
        if (declaresHost(executableModules[offset / 24], base)) continue;`],
    [`    std::vector<std::set<std::size_t>> dependencies(images.size());`, `    std::vector<std::set<std::size_t>> dependencies(images.size());
#ifdef __APPLE__
    std::vector<std::pair<std::size_t, std::size_t>> guestWins;
#endif`],
    [`            if (declaresHost(symbol.Library)) {`, `            if (declaresHost(symbol.Library, symbol.Name)) {`],
    [`            if (provider != nullptr) {`, `#ifdef __APPLE__
            bool guestOverride = false;
            if (provider == nullptr && macos && found != exports.end() && found->second.size() == 1 && !placeholderExports.contains(symbol.Name)) {
                provider = &found->second.front();
                guestOverride = true;
            }
#endif
            if (provider != nullptr) {`],
    [`                if (provider->Provider != index && referencedSymbols.contains(symbolIndex)) dependencies[index].insert(provider->Provider);`, `                if (provider->Provider != index && referencedSymbols.contains(symbolIndex)) {
#ifdef __APPLE__
                    if (guestOverride) guestWins.emplace_back(index, provider->Provider);
                    else
#endif
                    dependencies[index].insert(provider->Provider);
                }`],
    [`    std::vector<bool> required(images.size());`, `#ifdef __APPLE__
    const auto reaches = [&](std::size_t from, std::size_t to) {
        std::vector<std::size_t> pending{from};
        std::vector<bool> seen(images.size());
        while (!pending.empty()) {
            const auto current = pending.back();
            pending.pop_back();
            if (current == to) return true;
            if (seen[current]) continue;
            seen[current] = true;
            pending.insert(pending.end(), dependencies[current].begin(), dependencies[current].end());
        }
        return false;
    };
    for (const auto& [importer, provider] : guestWins)
        if (!dependencies[importer].contains(provider) && !reaches(provider, importer)) dependencies[importer].insert(provider);
#endif
    std::vector<bool> required(images.size());`],
    [`!declaresHost(symbol.Library) && !systemImports[module].contains(index)`, `!declaresHost(symbol.Library, symbol.Name) && !systemImports[module].contains(index)`]
  ]);
  return [relative, helper];
}
