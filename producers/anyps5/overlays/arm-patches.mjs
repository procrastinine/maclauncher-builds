// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export function applyArmPatches(root, directory, names) {
    // Apply directly to the exported source. The ceiling prevents discovery
    // of an enclosing checkout even when the runner's TMPDIR is inside one.
    const cwd = fs.realpathSync(root);
    const env = {...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd)};
    for (const name of names) {
        const input = fs.readFileSync(path.join(directory, name + '.patch'));
        const files = [...input.toString().matchAll(/^diff --git a\/(.*?) b\//gm)].map(match => match[1]);
        for (const file of files) if (!fs.statSync(path.join(cwd, file)).isFile()) throw Error('Missing ARM patch input: ' + file);
        const options = {cwd, env, input, stdio: ['pipe', 'pipe', 'pipe']};
        execFileSync('git', ['apply', '--check', '-'], options);
        execFileSync('git', ['apply', '-'], options);
    }
}
