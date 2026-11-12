// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
        throw Error('AnyPS5 progress reap boundary changed: ' + before.slice(0, 100));
    return source.replace(before, after);
}

export async function applyProgressReapOverlay(root) {
    const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics/src/Recorder.cpp');
    let source = await fs.readFile(file, 'utf8');
    source = replace(source, 'struct Recorder::ProgressWatcher {\n    std::atomic<std::uint64_t> submitted{0};',
        'struct Recorder::ProgressWatcher {\n    std::atomic<std::uint64_t> completed{0};\n    std::atomic<bool> failed{false};\n    std::atomic<std::uint64_t> submitted{0};');
    source = replace(source, '                if (result != VK_SUCCESS) {\n                    std::fprintf(stderr, "[gpu] progress watcher:',
        '                if (result != VK_SUCCESS) {\n                    failed.store(true, std::memory_order_release);\n                    std::fprintf(stderr, "[gpu] progress watcher:');
    source = replace(source, '                seen = std::max(target, value);\n                KernelWakeSleepers_nid_no_patch();',
        '                seen = std::max(target, value);\n                completed.store(seen, std::memory_order_release);\n                KernelWakeSleepers_nid_no_patch();');
    source = replace(source, '    void Submitted(std::uint64_t serial) {',
        '    bool MayHaveCompleted(std::uint64_t serial) const {\n' +
        '        return failed.load(std::memory_order_acquire) || completed.load(std::memory_order_acquire) >= serial;\n' +
        '    }\n\n    void Submitted(std::uint64_t serial) {');
    source = replace(source, '    while (!inFlight.empty()) {\n        if (fenceStatus(inFlight.front()->fence) != VK_SUCCESS) break;',
        '    while (!inFlight.empty()) {\n' +
        '#ifdef __APPLE__\n' +
        '        // The existing watcher supplies a negative filter for opportunistic reaps.\n' +
        '        // A timeline signal never replaces the fence check before reuse. A watcher\n' +
        '        // failure (or no timeline) falls back to the original fence polling path.\n' +
        '        if (progressWatcher && !progressWatcher->MayHaveCompleted(inFlight.front()->serial)) break;\n' +
        '#endif\n' +
        '        if (fenceStatus(inFlight.front()->fence) != VK_SUCCESS) break;');
    await fs.writeFile(file, source);
}
