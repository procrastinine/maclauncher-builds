import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readProjects} from '../lib/projects.mjs';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';

const root=path.resolve(import.meta.dirname,'..');

// Every package has everything it needs: each input a recipe names exists,
// and every source record and pin it reaches has the one record shape.
test('every project resolves its recipe inputs, app files and source records',()=>{
 const describe=createRecipeBuildReporter({directory:root}),problems=[];
 for(const project of readProjects(root,{resolvePins:false}).projects.filter(project=>project.build)){
  describe(project.id);
  for(const row of describe.unresolved(project.id).filter(row=>row.reason!=='computed'))problems.push({project:project.id,...row});
 }
 assert.deepEqual(problems,[]);
});
