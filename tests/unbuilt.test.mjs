import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {readProjects,buildRecord} from '../lib/projects.mjs';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';
import {resolveBuildInputs} from '../tools/resolve-build-inputs.mjs';

const root=path.resolve(import.meta.dirname,'..');

// A package is built when a catalog entry's build evidence records its
// current definition digest.
test('packages whose current definition has no recorded build',async t=>{
 const projects=readProjects(root,{resolvePins:false}).projects.filter(project=>project.build);
 const {reports}=await resolveBuildInputs({selection:projects.map(project=>({id:project.id,version:buildRecord(project).version})),describe:createRecipeBuildReporter({directory:root}),published:()=>null});
 const recorded=id=>{const file=path.join(root,'catalogs',id+'.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).packages.map(record=>record.build?.definitionDigest):[];};
 const unbuilt=projects.map(project=>project.id).filter(id=>!recorded(id).includes(reports[id].definitionDigest));
 t.diagnostic(`${unbuilt.length} of ${projects.length} unbuilt: ${unbuilt.join(' ')}`);
});
