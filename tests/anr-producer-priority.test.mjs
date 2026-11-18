import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import vm from 'node:vm';

const text = fs.readFileSync(new URL('../producers/package-support/src/modules/shared/reshade/generation/anr/build.mjs', import.meta.url), 'utf8');
const runner = text.replace(/^#![^\n]*\n|^import [^\n]+\n/gm, '');
const input = Buffer.from('converter header fixture');
const header = '/headers/metal_irconverter/metal_irconverter.h';
const pin = {
    minimumMacOS: '26.0',
    converterHeaders: {files: {'metal_irconverter/metal_irconverter.h': crypto.createHash('sha256').update(input).digest('hex')}}
};
const tools = (priority, headerBytes = input) => {
    const calls = [], outputs = new Map();
    const execute = (file, args) => {
        calls.push({file, args: Array.from(args)});
        if (file === 'ps') return ' ' + priority + '\n';
    };
    const fs = {
        readFileSync(file) {
            if (file === '/app/src/modules/shared/reshade/generation/anr/source.json') return JSON.stringify(pin);
            assert.equal(file, header);
            return headerBytes;
        },
        writeFileSync: (file, bytes) => outputs.set(file, bytes)
    };
    const run = () => vm.runInNewContext(runner, {
        fs, path, crypto, appPath: relative => '/app/' + relative,
        process: {argv: ['node', 'build.mjs', '/headers', '/output'], pid: 42},
        execFileSync: execute, addLicense() {}
    });
    return {run, calls, outputs};
};

for (const priority of [-10, 0, 5, 19]) {
    test('ANR producer uses the caller priority ' + priority, () => {
        const {run, calls, outputs} = tools(priority);
        run();
        assert.deepEqual(calls.map(call => call.file), ['cmake', 'cmake', 'cmake', 'codesign', 'codesign', 'codesign']);
        assert.ok(calls[0].args.includes('-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64'));
        assert.ok(calls[0].args.includes('-DANR_CONVERTER_INCLUDE=/headers'));
        assert.equal(JSON.parse(outputs.get('/output/payload/provider.json')).userSideAssets, true);
    });
}

test('ANR still rejects a converter header that differs from the pin', () => {
    const {run, calls} = tools(-10, Buffer.from('other bytes'));
    assert.throws(run, /ANR converter headers differ from the declared exact source/);
    assert.deepEqual(calls, []);
});
