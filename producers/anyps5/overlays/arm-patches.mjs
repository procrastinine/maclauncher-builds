// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export function applyArmPatches(root, directory, names) {
    // Run outside a Git worktree: Git can otherwise silently skip paths in a
    // projection nested below Builds. Each patch must apply completely.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'anyps5-patch-'));
    try {
        for (const name of names) {
            const input = fs.readFileSync(path.join(directory, name + '.patch'));
            const files = [...input.toString().matchAll(/^diff --git a\/(.*?) b\//gm)].map(match => match[1]);
            for (const file of files) if (!fs.statSync(path.join(root, file)).isFile()) throw Error('Missing ARM patch input: ' + file);
            execFileSync('git', ['apply', '--check', '--unsafe-paths', '--directory=' + path.resolve(root), '-'], {cwd, input, stdio: ['pipe', 'pipe', 'pipe']});
            execFileSync('git', ['apply', '--unsafe-paths', '--directory=' + path.resolve(root), '-'], {cwd, input, stdio: ['pipe', 'pipe', 'pipe']});
        }
    } finally { fs.rmSync(cwd, {recursive: true, force: true}); }
}
