// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

export function applyWorkerQosOverlay(root) {
    const file = 'core/libs/prx/libSceAgcDriver/Execution/src/ThreadPriority.cpp';
    const target = path.join(root, file);
    const source = fs.readFileSync(target, 'utf8');
    const before = 'void RaiseWorkerThreadPriority(const char* role) {\n    if (RequestedMode() == ThreadPriorityMode::Off) return;';
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
        throw Error('AnyPS5 worker QoS boundary changed: ' + file);
    const after = `void RaiseWorkerThreadPriority(const char* role) {
#ifdef __APPLE__
    // Frame-critical threads request QoS independently of the optional priority mode.
    if (std::strncmp(role, "queue 0x", 8) == 0 || std::strcmp(role, "draw committer") == 0 || std::strcmp(role, "presenter") == 0) {
        const int error = pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
        if (error != 0) LogOnce(role, std::string("user-interactive QoS refused: ") + std::strerror(error));
        else LogOnce(role, "user-interactive QoS");
        return;
    }
#endif
    if (RequestedMode() == ThreadPriorityMode::Off) return;`;
    fs.writeFileSync(target, source.replace(before, after));
    return [file];
}
