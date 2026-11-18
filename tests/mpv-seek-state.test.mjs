import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../producers/mpv-render/v7/native/mpv-render.mm',import.meta.url),'utf8');
const begin=source.indexOf('- (BOOL)createPresenter:');
const presenter=source.slice(begin,source.indexOf('- (void)preparationReadyForEpoch:',begin));
test('mpv distinguishes seek presentation from media preparation',()=>{
 assert.match(source,/MPV_EVENT_SEEK\)publishSource\([^;]*,true,true\)/);
 assert.match(source,/preparationEpoch=previous->preparationEpoch\+\(media&&!seek\)/);
 assert.match(source,/next\.epoch=previous->epoch\+media/);
});
test('mpv keeps content-epoch support optional for older graphics runtimes',()=>{
 assert.match(source,/dlsym\(RTLD_DEFAULT,"rsBeginFramePresenterContentEpoch"\)/);
 const ready=source.match(/return create && headroom && destroy && source && observe && submit;/);
 assert.ok(ready,'the existing presenter interface remains sufficient');
 assert.match(presenter,/_presenterPreparationEpoch==source->preparationEpoch&&_graphics\.beginEpoch/);
});
test('mpv waits for busy epoch retirement without destroying prepared resources',()=>{
 const retained=presenter.indexOf('_graphics.beginEpoch(_presenter,source->epoch)');
 const retry=presenter.indexOf('if(result==RS_FRAME_BUSY){[self again];return NO;}');
 const destroy=presenter.indexOf('_graphics.destroy(_presenter)');
 assert.ok(retained>=0&&retry>retained&&destroy>retry);
 assert.match(presenter,/_graphics\.headroom\(_presenter,_displayHeadroom\.load\(\)\);return YES;\s*\}/);
});
test('mpv preparation notifications and swap receipts keep their own epochs',()=>{
 assert.match(source,/new PreparationWake\{self,_presenterPreparationEpoch\}/);
 assert.match(source,/self->_presenterPreparationEpoch!=epoch/);
 assert.match(source,/new SwapReceipt\{self,job\.content\.epoch\}/);
 assert.match(source,/std::atomic_load\(&self->_sourceState\)->epoch==epoch\)self->_api\.mpv_render_context_report_swap/);
});
