import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {appPath} from '../tools/app-source.mjs';

test('graphics CMake includes every declared native-link overlay implementation',()=>{
 const overlay=JSON.parse(fs.readFileSync(new URL('../producers/package-support/src/modules/shared/reshade/native/source-overlay.json',import.meta.url)));
 const cmake=fs.readFileSync(appPath('src/modules/shared/reshade/native/CMakeLists.txt'),'utf8').replace(/#[^\n]*/g,'');
 const inputs=new Set(cmake.match(/src\/[\w./-]+/g));
 const missing=overlay.files.filter(entry=>entry.nativeLink&&!inputs.has(entry.path)).map(entry=>entry.path);
 assert.deepEqual(missing,[],'Every declared native implementation must reach the production link');
});
