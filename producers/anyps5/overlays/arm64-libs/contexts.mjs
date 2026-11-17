// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

function replace(source, before, after, file) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw Error('AnyPS5 guest context boundary changed: ' + file);
    return source.replace(before, after);
}

export function copyArm64GuestContextSources(root) {
    const libc = path.join(root, 'core/libs/prx/libc');
    for (const [from, to] of [['GuestContextArm64.hpp', 'include/GuestContextArm64.hpp'], ['GuestContextArm64.cpp', 'src/GuestContextArm64.cpp'], ['JumpBufferArm64.inc', 'include/JumpBufferArm64.inc'], ['SignalJumpArm64.inc', 'include/SignalJumpArm64.inc']]) {
        const bytes = fs.readFileSync(new URL(from, import.meta.url));
        const file = path.join(libc, to);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) fs.writeFileSync(file, bytes);
    }
}

export function applyArm64ContextsOverlay(root) {
    copyArm64GuestContextSources(root);
    const file = 'core/libs/prx/libkernel/System/src/UserContext.cpp';
    const full = path.join(root, file);
    let source = fs.readFileSync(full, 'utf8');
    source = replace(source, '#include <immintrin.h>', '#if defined(__aarch64__)\n#include "prx/libc/include/GuestContextArm64.hpp"\n#include "prx/libc/include/GuestCpu.hpp"\n#else\n#include <immintrin.h>\n#endif', file);
    const begin = source.indexOf('struct RegisterFrame {');
    const end = source.indexOf('\n};', begin);
    if (begin < 0 || end < 0) throw Error('AnyPS5 register frame boundary changed');
    source = source.slice(0, begin) + '#if defined(__aarch64__)\nusing RegisterFrame = GuestContext::RegisterFrame;\n#else\n' + source.slice(begin, end + 3) + '\n#endif' + source.slice(end + 3);
    source = replace(source, 'std::uint32_t HostMxcsrMask() {', 'std::uint32_t HostMxcsrMask() {\n#if defined(__aarch64__)\n    return GuestCpu::MxcsrMask();\n#else', file);
    source = replace(source, '    return mask;\n}', '    return mask;\n#endif\n}\n\nstd::uint64_t CurrentFlags() {\n#if defined(__aarch64__)\n    return GuestContext::Capture().rflags;\n#else\n    return __builtin_ia32_readeflags_u64();\n#endif\n}', file);
    const declaration = 'extern "C" [[noreturn]] void APS5_VABI Aps5ContextRestore_nid_no_patch(const RegisterFrame* frame);';
    source = replace(source, declaration, `#if defined(__aarch64__)
extern "C" {
int APS5_VABI Aps5GetcontextFinish_nid_no_patch(UserUcontext*, const RegisterFrame*);
int APS5_VABI Aps5SwapcontextFinish_nid_no_patch(UserUcontext*, const UserUcontext*, const RegisterFrame*);
int APS5_VABI getcontext_nid_postfix(UserUcontext* context) {
    const auto frame = GuestContext::CaptureCall();
    return Aps5GetcontextFinish_nid_no_patch(context, &frame);
}
int APS5_VABI swapcontext_nid_postfix(UserUcontext* saved, const UserUcontext* next) {
    const auto frame = GuestContext::CaptureCall();
    return Aps5SwapcontextFinish_nid_no_patch(saved, next, &frame);
}
[[noreturn]] void APS5_VABI Aps5ContextRestore_nid_no_patch(const RegisterFrame* frame) {
    GuestContext::Restore(*frame);
}
}
#else
${declaration}`, file);
    source = replace(source, '    "    iretq\\n");', '    "    iretq\\n");\n#endif', file);
    source = replace(source, '        _fxsave64(frame.fxsave);', '#if defined(__aarch64__)\n        const auto current = GuestContext::Capture();\n        std::memcpy(frame.fxsave, current.fxsave, sizeof(frame.fxsave));\n#else\n        _fxsave64(frame.fxsave);\n#endif', file);
    source = replace(source, '((machine.rflags ^ __builtin_ia32_readeflags_u64())', '((machine.rflags ^ CurrentFlags())', file);
    fs.writeFileSync(full, source);
    for (const [relative, boundary, include] of [
        ['core/libs/prx/libc/src/JumpBuffer.cpp', '#if defined(_WIN32) || defined(__APPLE__)\n#define APS5_JUMP_ASM_CALL', 'JumpBufferArm64.inc'],
        ['core/libs/prx/libkernel/System/src/SignalSets.cpp', '#define APS5_SIGNAL_ASM_FUNCTION', 'SignalJumpArm64.inc'],
    ]) {
        const file = path.join(root, relative);
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, replace(text, boundary,
            '#if defined(__aarch64__)\n#include "prx/libc/include/' + include + '"\n#else\n' + boundary, relative) + '\n#endif\n');
    }
    const cmake = path.join(root, 'core/libs/prx/libc/CMakeLists.txt');
    fs.appendFileSync(cmake, '\ntarget_sources(libc PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/GuestContextArm64.cpp)\n');
}
