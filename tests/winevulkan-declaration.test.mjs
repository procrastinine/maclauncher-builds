import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {publicDeclaration} from '../tools/runtime-package.mjs';
import {wineHost} from '../tools/wine-host.mjs';

const here = fileURLToPath(new URL('../producers/package-support/src/modules/crossover/temporal/vulkan/', import.meta.url));
const source = JSON.parse(fs.readFileSync(path.join(here, 'source.json')));
const code = fs.readFileSync(path.join(here, 'build.mjs'), 'utf8');
const start = code.indexOf('export function moduleArchitectures(');
const end = code.indexOf('export function publishModule(', start);
assert.ok(start >= 0 && end > start);

for (const arch of ['arm64', 'x64']) {
    test('WineVulkan seals ' + arch + ' from native slices and the declared PE machine', t => {
        const output = fs.mkdtempSync(path.join(os.tmpdir(), 'winevulkan-declaration-'));
        t.after(() => fs.rmSync(output, {recursive: true, force: true}));
        const host = wineHost(arch), cpu = host.macho, guest = host.unix.replace(/-unix$/, '-windows');
        const profile = arch === 'arm64' ? JSON.parse(fs.readFileSync(path.join(here, source.hostProfiles[arch]))) : source;
        const files = [
            [host.unix + '/winevulkan.so', {format: 'macho', architectures: [cpu]}],
            [guest + '/winevulkan.dll', {format: 'pe', machine: arch === 'arm64' ? 'arm64x' : 'x86_64'}, cpu],
            ['i386-windows/winevulkan.dll', {format: 'pe', machine: 'i386'}, 'x86']
        ];
        const gl = arch === 'arm64' ? [
            [host.unix + '/maclauncher-opengl32.so', {format: 'macho', architectures: [cpu]}],
            [guest + '/maclauncher-opengl32.dll', {format: 'pe', machine: 'arm64x'}, cpu],
            ['i386-windows/maclauncher-opengl32.dll', {format: 'pe', machine: 'i386'}, 'x86']
        ] : [];
        const rows = new Map([...files, ...gl].map(([name, ...facts]) => [path.join(output, name), facts]));
        for (const [file] of rows) {
            fs.mkdirSync(path.dirname(file), {recursive: true});
            fs.writeFileSync(file, path.relative(output, file));
        }
        const appRequire = name => {
            switch (name) {
                case 'src/core/binary-arch': return {inspectBinary: file => rows.get(file)[0]};
                case 'src/modules/shared/runtime/pe-exports': return {readPeExports: file => ({architecture: rows.get(file)[1]})};
                default: throw Error('Unexpected module request ' + name);
            }
        };
        const describe = vm.runInNewContext(code.slice(start, end).replaceAll('export function ', 'function ') + '\ndescribeModule', {
            fs, path, here, source, wineHost, appRequire,
            addLicense() {}, addLicenses() {},
            digest: bytes => createHash('sha256').update(bytes).digest('hex'),
            writeChanged: fs.writeFileSync,
            openGLPaths: () => gl.map(([name]) => name)
        });
        describe({directory: output, output, arch, profile, modules: files.map(([name]) => [name, name])});
        const declaration = JSON.parse(fs.readFileSync(path.join(output, 'runtime-package.json')));
        assert.equal(publicDeclaration(declaration), declaration);
        assert.deepEqual(declaration.launcherArchitectures, arch === 'arm64' ? ['arm64'] : ['arm64', 'x64']);
        for (const [name, facts, machine] of [...files, ...gl]) {
            const entry = declaration.files.find(file => file.path === name);
            assert.deepEqual(entry.architectures, machine ? [machine] : [cpu]);
            assert.equal(entry.executionArchitecture, facts.format === 'macho' && arch === 'x64' ? 'x86_64' : undefined);
        }
    });
}
