import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const root=path.resolve(import.meta.dirname,'..');
test('the FEX producer consumes every retained core overlay once in numeric order',()=>{
 const directory=path.join(root,'producers/anyps5-fex'),recipe=JSON.parse(fs.readFileSync(path.join(directory,'source.json'),'utf8'));
 const files=fs.readdirSync(path.join(directory,'overlays/fex')).filter(file=>/^\d{4}.*\.patch$/.test(file)).sort();
 const selected=recipe.overlays.filter(row=>row.target==='fex');
 assert.deepEqual(selected.map(row=>row.file),files.map(file=>'overlays/fex/'+file));
 assert.ok(selected.every(row=>row.license==='MIT'&&typeof row.summary==='string'&&row.summary.length>0));
});
