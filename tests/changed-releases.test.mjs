import test from 'node:test';import assert from 'node:assert/strict';
import {changedReleaseLines} from '../tools/changed-releases.mjs';
test('release pushes select only added or changed lines',()=>{
 const all='engine=1.0.0\nhelper=2.0.0\n';assert.deepEqual(changedReleaseLines('',all),['engine=1.0.0','helper=2.0.0']);
 assert.deepEqual(changedReleaseLines(all,'engine=1.0.1\nhelper=2.0.0\n'),['engine=1.0.1']);
 assert.deepEqual(changedReleaseLines(all,all),[]);assert.deepEqual(changedReleaseLines(all,'helper=2.0.0\n'),[]);
});
