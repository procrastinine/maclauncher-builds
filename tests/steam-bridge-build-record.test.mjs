import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {buildPlan} from '../tools/build-runtime.mjs';
import {compile,assemble} from '../producers/steam-bridge/build.mjs';
test('Steam bridge resolves an ordinary universal build with directory source closure',()=>{
 const project=resolveProject('maclauncher-steam-bridge',undefined,{resolvePins:false});
 assert.deepEqual(project.producer.entries,['producers/steam-bridge']);
 assert.equal(buildRecord(project).command,'producers/steam-bridge/build.mjs');
 assert.deepEqual(buildRecord(project).submodules,project.upstreams.map(row=>row.pin.gitlink));
 assert.deepEqual(buildPlan({project:project.id}).include.map(row=>row.arch),['universal']);
 assert.equal(typeof compile,'function');
 assert.equal(typeof assemble,'function');
});
