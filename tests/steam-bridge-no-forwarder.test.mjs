import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as producer from '../producers/steam-bridge/build.mjs';

test('the bridge packaging API no longer depends on upstream allocation-bound prediction', () => {
 assert.equal(typeof producer.packageOutput,'function');
 assert.equal(producer.forwarderArena,undefined);
 const pin=JSON.parse(fs.readFileSync(new URL('../producers/steam-bridge/source.json',import.meta.url)));
 assert.equal(pin.forwarderArena,undefined);
});
