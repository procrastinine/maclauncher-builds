import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {recipeBuildReport} from '../tools/recipe-build-report.mjs';
import {resolveProject} from '../lib/projects.mjs';
const directory=path.resolve(import.meta.dirname,'..');
test('nxnative recipe discovery includes every tracked owned producer input',()=>{
 const project=resolveProject('nxnative-tools',directory,{resolvePins:false});
 assert.deepEqual(project.producer.entries,[project.producer.sourceDirectory]);
 const tracked=execFileSync('git',['ls-files','--','producers/nxnative'],{cwd:directory,encoding:'utf8'}).trim().split('\n');
 const report=recipeBuildReport({id:project.id,directory}),actual=new Set(report.definition.files.map(f=>f.path));
 assert.ok(tracked.length>0);for(const file of tracked)assert.ok(actual.has(file),'Recipe omitted '+file);
});
