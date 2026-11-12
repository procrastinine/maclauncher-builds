import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyDepthRenderControlOverlay} from '../producers/anyps5/overlays/depth-render-control/apply.mjs';

const upstream=process.env.ANYPS5_TEST_SOURCE||fileURLToPath(new URL('../sources/anyps5/',import.meta.url));
const precheck='core/libs/prx/libSceAgcDriver/Execution/src/Driver/Draw/DrawPrecheck.cpp';
const skip=fs.existsSync(path.join(upstream,precheck))?false:'Source tree sources/anyps5 is not initialized.';

function projection(t,adapt=source=>source){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'anyps5-draw-precheck-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const target=path.join(root,precheck);
 fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(target,adapt(fs.readFileSync(path.join(upstream,precheck),'utf8')));
 return root;
}
function body(source,signature){
 const start=source.indexOf(signature),end=source.indexOf('\n}\n',start);
 assert.ok(start>=0&&end>start,signature);
 return source.slice(start,end)+'\n}\n';
}

test('single-sample depth render control neither drains the draw pipeline nor takes the note',{skip},async t=>{
 const root=projection(t);
 await applyDepthRenderControlOverlay(root);
 const source=body(fs.readFileSync(path.join(root,precheck),'utf8'),'std::optional<DrawVerdict> Driver::precheckDraw(');
 const condition=source.indexOf('control && control->samples != 1u && Graphics::DepthRenderControlDrains(*control)');
 assert.ok(condition>0&&condition<source.indexOf('DrawPipeline::DrainReason::Packet, (packet[0] >> 8u) & 0xffu);\n        Graphics::NoteDepthRenderControl(*control);'));
});

test('an unrecognized precheck anchor is refused',{skip},async t=>{
 const root=projection(t,source=>{
  const changed=source.replace('Graphics::DepthRenderControlDrains(*control)','Graphics::DepthRenderControlDrains(queue)');
  assert.notEqual(changed,source,'The fixture must alter the selected upstream predicate.');
  return changed;
 });
 await assert.rejects(applyDepthRenderControlOverlay(root),/draw precheck source changed/);
});
