// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

export function copyArm64GuestThreadSources(root) {
    const libc = path.join(root, 'core/libs/prx/libc');
    for (const [from, to] of [['GuestThreadArm64.hpp', 'include/GuestThreadArm64.hpp'], ['GuestThreadArm64.cpp', 'src/GuestThreadArm64.cpp']]) {
        const destination = path.join(libc, to);
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        fs.writeFileSync(destination, fs.readFileSync(new URL(from, import.meta.url)));
    }
    const stack = path.join(root, 'core/libs/prx/libkernel/Pthread/src/GuestThreadStackArm64.hpp');
    fs.mkdirSync(path.dirname(stack), {recursive: true});
    fs.writeFileSync(stack, fs.readFileSync(new URL('./GuestThreadStackArm64.hpp', import.meta.url)));
}

export function applyArm64ThreadsOverlay(root) {
    const edit = (relative, transform) => {
        const file = path.join(root, relative);
        let source = fs.readFileSync(file, 'utf8');
        const replace = (before, after) => {
            if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
                throw Error('AnyPS5 arm64 thread boundary changed: ' + relative + ': ' + before.slice(0, 64));
            source = source.replace(before, after);
        };
        transform(replace);
        fs.writeFileSync(file, source);
    };
    copyArm64GuestThreadSources(root);
    fs.appendFileSync(path.join(root, 'core/libs/prx/libc/CMakeLists.txt'),
        '\ntarget_sources(libc PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/GuestThreadArm64.cpp)\n');
    edit('core/libs/prx/libkernel/Pthread/src/Thread.cpp', replace => {
        replace('#include "prx/libc/include/GuestGs.hpp"',
            '#include "prx/libc/include/GuestGs.hpp"\n#if defined(__aarch64__)\n' +
            '#include "prx/libc/include/GuestCpu.hpp"\n' +
            '#include "prx/libc/include/GuestThreadArm64.hpp"\n#include "GuestThreadStackArm64.hpp"\n#include <optional>\n#endif');
        replace('asm(".text\\n"\n    APS5_ASM_FUNCTION("Aps5CallGuestEntry_nid_no_patch")',
            '#if defined(__aarch64__)\n' +
            'extern "C" void* APS5_VABI Aps5CallGuestEntry_nid_no_patch(PthreadEntry entry, void* arg) {\n' +
            '    return reinterpret_cast<void*>(GuestThread::Call(reinterpret_cast<std::uintptr_t>(entry), reinterpret_cast<std::uintptr_t>(arg)));\n' +
            '}\n#else\nasm(".text\\n"\n    APS5_ASM_FUNCTION("Aps5CallGuestEntry_nid_no_patch")');
        replace(')" APS5_ASM_FUNCTION_END("Aps5CallGuestEntry_nid_no_patch"));',
            ')" APS5_ASM_FUNCTION_END("Aps5CallGuestEntry_nid_no_patch"));\n#endif');
        replace('    asm volatile("fldcw %0" : : "m"(GUEST_THREAD_FPU_CONTROL));',
            '#if defined(__aarch64__)\n    GuestCpu::SetX87Control(GUEST_THREAD_FPU_CONTROL);\n' +
            '#else\n    asm volatile("fldcw %0" : : "m"(GUEST_THREAD_FPU_CONTROL));\n#endif');
        replace('static void* StartNativeThread(void* opaque) {\n    std::unique_ptr<NativeThreadArgs> args(static_cast<NativeThreadArgs*>(opaque));\n    auto* self = args->guest->self;',
            'static void* StartNativeThread(void* opaque) {\n    std::unique_ptr<NativeThreadArgs> args(static_cast<NativeThreadArgs*>(opaque));\n' +
            '    auto* self = args->guest->self;\n#if defined(__aarch64__)\n' +
            '    std::optional<GuestThread::MappedStack> guestStack;\n' +
            '    std::optional<GuestThread::Scope> guestScope;\n#endif');
        replace('        args->initialized.set_value();\n    } catch (...) {\n        args->initialized.set_exception(std::current_exception());\n        return nullptr;',
            '#if defined(__aarch64__)\n' +
            '        guestStack.emplace(self->stackSize);\n' +
            '        self->stackAddress = reinterpret_cast<void*>(guestStack->Low());\n' +
            '        self->stackSize = guestStack->Bytes();\n' +
            '        guestScope.emplace(reinterpret_cast<std::uintptr_t>(self->stackAddress), self->stackSize);\n' +
            '#endif\n        args->initialized.set_value();\n    } catch (...) {\n' +
            '        args->initialized.set_exception(std::current_exception());\n        return nullptr;');
        const sharedStack = '    const auto stackEnd = reinterpret_cast<std::uintptr_t>(self->stackAddress) + self->stackSize;\n' +
            '    if (const auto frame = reinterpret_cast<std::uintptr_t>(__builtin_frame_address(0)); frame > stackEnd)\n' +
            '        static_cast<volatile unsigned char*>(alloca(frame - stackEnd))[0] = 0;';
        replace(sharedStack, '#if !defined(__aarch64__)\n' + sharedStack + '\n#endif');
    });
    edit('core/libs/prx/libkernel/Pthread/src/MainThreadMacOs.cpp', replace => {
        replace('#include "prx/libc/include/GuestArena.hpp"',
            '#include "prx/libc/include/GuestArena.hpp"\n#if defined(__aarch64__)\n' +
            '#include "prx/libc/include/GuestThreadArm64.hpp"\n#include "GuestThreadStackArm64.hpp"\n#endif');
        replace('#include "GuestMainLifecycle.inc"',
            '#include "GuestMainLifecycle.inc"\n#if defined(__aarch64__)\n' +
            'extern "C" int Aps5CallGuestProcessEntry_nid_no_patch(void* entry, const void* block, void (*callback)()) {\n' +
            '    return GuestThread::CallProcess(reinterpret_cast<std::uintptr_t>(entry), reinterpret_cast<std::uintptr_t>(block), callback);\n' +
            '}\n#endif');
        replace('    guestMainThread = true;',
            '#if defined(__aarch64__)\n' +
            '    GuestThread::MappedStack stack(guestStackBytes);\n' +
            '    GuestThread::Scope guestScope(stack.Low(), stack.Bytes());\n' +
            '#endif\n    guestMainThread = true;');
    });
}
