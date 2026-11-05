import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 write-watch source changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}

export async function applyFaultAheadOverlay(root) {
  const file = path.join(root, 'core/libs/prx/libc/src/GuestWriteWatch.cpp');
  const original = await fs.readFile(file, 'utf8');
  const begin = original.indexOf('#elif defined(__APPLE__)\nclass Watch {');
  if (begin < 0) throw Error('AnyPS5 Apple write-watch source changed');
  let source = original.slice(begin);
  source = replace(source, '    Watch() {\n        if (std::getenv("APS5_NO_WRITE_WATCH")',
    '    Watch() {\n        if (const char* ahead = std::getenv("APS5_WRITE_WATCH_FAULT_AHEAD")) _faultAhead = static_cast<std::size_t>(std::strtoul(ahead, nullptr, 0));\n        if (std::getenv("APS5_NO_WRITE_WATCH")');
  source = replace(source, '    static constexpr std::uint8_t Fresh = 0x40;',
    '    static constexpr std::uint8_t Fresh = 0x40;\n    static constexpr std::uintptr_t FaultAheadBlock = 65536;');
  source = replace(source, `        auto& state = it->second.pages[(page - it->first) / _page];
        if ((state & Protected) != 0) {
            if (::mprotect(reinterpret_cast<void*>(page), _page, state & ProtectionMask) != 0) return false;
            state = static_cast<std::uint8_t>((state & (ProtectionMask | Fresh)) | Written);
            return true;
        }`, `        auto& pages = it->second.pages;
        const auto index = static_cast<std::size_t>((page - it->first) / _page);
        auto& state = pages[index];
        if ((state & Protected) != 0) {
            const auto protection = state & ProtectionMask;
            const auto writtenOpen = [&](std::size_t at) { return (pages[at] & (Written | Protected)) == Written && (pages[at] & ProtectionMask) == protection; };
            std::size_t count = 1;
            if ((protection & PROT_WRITE) != 0 && _faultAhead > 1 && index >= 2 && writtenOpen(index - 1) && writtenOpen(index - 2)) {
                const auto blockPages = static_cast<std::size_t>(((page | (FaultAheadBlock - 1)) + 1 - page) / _page);
                const auto limit = std::min({_faultAhead, blockPages, pages.size() - index});
                while (count < limit && (pages[index + count] & Protected) != 0 && (pages[index + count] & ProtectionMask) == protection) ++count;
            }
            if (::mprotect(reinterpret_cast<void*>(page), count * _page, protection) != 0) return false;
            for (std::size_t at = index; at < index + count; ++at) pages[at] = static_cast<std::uint8_t>((pages[at] & (ProtectionMask | Fresh)) | Written);
            return true;
        }`);
  source = replace(source, '    const std::uintptr_t _page = static_cast<std::uintptr_t>(::getpagesize());',
    '    const std::uintptr_t _page = static_cast<std::uintptr_t>(::getpagesize());\n    std::size_t _faultAhead = FaultAheadBlock / _page;');
  await fs.writeFile(file, original.slice(0, begin) + source);
}

/*
 * Portions adapted from AnyPS5 (GPL-2.0-only).
 * sequential fault-ahead:
 * https://github.com/boykopovar/AnyPS5/commit/54080056ff07088c09b13a4c297ae895af5d60c1
 * protection-block boundary:
 * https://github.com/boykopovar/AnyPS5/commit/2c15fa59b430fc04a949877a01e8bd27cd307606
 * adapted writable-page restriction:
 * https://github.com/boykopovar/AnyPS5/commit/21e65cc7b3e3312f4b690af726e0dc577d5a3da4
 */
