import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../producers/package-support/src/modules/crossover/temporal/vulkan/build.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const run=');
const end = source.indexOf('async function verifyArchive(', start);
assert.ok(start >= 0 && end > start, 'the Wine make runner is present');

for (const priority of [-10, 0, 5, 19]) {
    test('Wine make inherits caller priority ' + priority, () => {
        const calls = [];
        const execFileSync = (command, args, options) => {
            calls.push({command, args: Array.from(args), options: {...options}});
            return command === 'ps' ? ' ' + priority + '\n' : 'built';
        };
        const runMake = vm.runInNewContext(source.slice(start, end) + '\nrunMake', {execFileSync, process: {pid: 42}});
        const args = ['-j2', 'install'];
        const options = {cwd: '/build', env: {BISON: '/tools/bison'}};

        assert.equal(runMake(args, options), 'built');
        assert.deepEqual(calls, [{command: 'make', args, options: {stdio: 'inherit', ...options}}]);
    });
}
