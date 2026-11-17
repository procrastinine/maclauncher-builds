import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyProfile, source} from '../producers/crossover-winemac/overlay.mjs';
import {buildWinemac} from '../producers/crossover-winemac/build.mjs';
test('winemac refuses a different Unix ABI before creating build output', async () => {
 await assert.rejects(buildWinemac({arch:'arm64'}), /x86_64/);
});
test('winemac leaves unrecognized source untouched', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'winemac-source-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,source.original.file), bytes='unrecognized source\n';
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
 assert.throws(()=>applyProfile(root),/declared original/);
 assert.equal(fs.readFileSync(file,'utf8'),bytes);
});
test('winemac adapts Metal-view teardown in the checked original before appending the window callback', async t => {
 const {prepareSceneWindow} = await import('../producers/crossover-winemac/scene-window.mjs');
 const {adaptSurfaceLifetime} = await import('../producers/crossover-winemac/surface-lifetime.mjs');
 const crypto = await import('node:crypto');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'winemac-window-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const release=`void macdrv_view_release_metal_view(macdrv_metal_view v)
{
    WineMetalView* view = (WineMetalView*)v;
    OnMainThread(^{
        [view removeFromSuperview];
        [view release];
    });
}`;
 const texts={'dlls/winemac.drv/Makefile.in':'SOURCES = \\\n\tmacdrv_main.c \\\n','dlls/winemac.drv/cocoa_window.m':'head\n'+release+'\ntail\n'};
 const originals={};
 for(const [file,text] of Object.entries(texts)){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);originals[file]=crypto.createHash('sha256').update(text).digest('hex');}
 const prepared=prepareSceneWindow(root,{originals},adaptSurfaceLifetime);
 const cocoa=prepared.files['dlls/winemac.drv/cocoa_window.m'];
 assert.match(cocoa,/static void release_metal_view_on_main/);
 assert.ok(!cocoa.includes(release));
 assert.ok(cocoa.startsWith(adaptSurfaceLifetime(texts['dlls/winemac.drv/cocoa_window.m'])+'\n')&&cocoa.length>texts['dlls/winemac.drv/cocoa_window.m'].length+release.length);
 assert.equal(prepared.record.files.find(file=>file.file.endsWith('cocoa_window.m')).adaptedSha256,crypto.createHash('sha256').update(cocoa).digest('hex'));
 assert.throws(()=>adaptSurfaceLifetime('no anchor'),/anchor differs/);
});
test('winemac has an ordinary build plan with every archive input declared', async () => {
 const {fileURLToPath} = await import('node:url');
 const {resolveProject} = await import('../lib/projects.mjs');
 const {buildPlan} = await import('../tools/build-runtime.mjs');
 const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
 const project = resolveProject(source.id, root, {resolvePins:false});
 assert.equal(project.build.command, 'producers/crossover-winemac/build.mjs');
 assert.deepEqual(buildPlan({project:project.id, directory:root, version:source.version}).include.map(row => row.arch), ['x64']);
 const declared = new Set(project.build.archives.map(input => input.file + '#' + input.pointer));
 for (const input of ['producers/dependencies/crossoverWine.json#', 'producers/dependencies/llvmMingw.json#',
  'producers/crossover-winemac/source.json#/bison', 'producers/crossover-winemac/source.json#/vulkanLinkInput/archive'])
  assert.ok(declared.has(input), input);
});
