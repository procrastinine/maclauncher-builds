import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applyStorageRemapOverlay} from '../producers/anyps5/overlays/storage-remap/apply.mjs';

const upstream=process.env.ANYPS5_TEST_SOURCE||fileURLToPath(new URL('../sources/anyps5/',import.meta.url));
const graphics='core/libs/prx/libSceAgcDriver/Graphics';
const libc='core/libs/prx/libc';
const files=[graphics+'/include/Texture.hpp',graphics+'/src/Texture.cpp',libc+'/include/GuestAllocations.hpp',libc+'/src/GuestAllocations.cpp',libc+'/include/specifics/linux/ElfTypes.hpp'];
const skip=files.every(file=>fs.existsSync(path.join(upstream,file)))?false:'Source tree sources/anyps5 is not initialized.';

function projection(t,adapt=source=>source){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'anyps5-storage-remap-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const file of files){
  const target=path.join(root,file);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,adapt(fs.readFileSync(path.join(upstream,file),'utf8'),file));
 }
 return root;
}
function body(source,signature){
 const start=source.indexOf(signature),end=source.indexOf('\n}\n',start);
 assert.ok(start>=0&&end>start,signature);
 return source.slice(start,end)+'\n}\n';
}

test('the overlay records pending allocation ownership and drops before unsaved-byte failures',{skip},async t=>{
 const root=projection(t);
 await applyStorageRemapOverlay(root);
 const source=fs.readFileSync(path.join(root,files[1]),'utf8');
 const pending=body(source,'void StorageTexture::markLayersPending(std::uint32_t first, std::uint32_t count) {');
 assert.match(pending,/if \(!layerPending\[layer\]\) pendingBacking\[layer\] = UnitBacking/);
 assert.ok(pending.indexOf('pendingBacking[layer] = UnitBacking')<pending.indexOf('layerPending.SetRange(first, count, true);'));
 const writeBack=body(source,'void StorageTexture::writeBackLayers(const std::vector<bool>& layers) {');
 const dropped=writeBack.indexOf('memory re-registered under another allocation');
 const failures=[...writeBack.matchAll(/Require\(!unsavedOutsideWatch, unsavedCause\);/g)].map(match=>match.index);
 assert.equal(failures.length,2);
 assert.ok(dropped>=0&&dropped<writeBack.indexOf('struct ReleaseReadTrap {')&&failures.every(index=>dropped<index));
});

test('unrecognized write-back and allocation lifecycle anchors are refused',{skip},async t=>{
 for(const [file,anchor,changed] of [
  [files[1],'    if (lastStored <= firstStored) return;\n','    if (lastStored <= firstStored) { return; }\n'],
  [files[3],'range.releasable, gpuMapped, backing}','range.releasable, gpuMapped, backing + 0}'],
 ]){
  const root=projection(t,(source,current)=>current===file?source.replace(anchor,changed):source);
  await assert.rejects(applyStorageRemapOverlay(root),/storage image write-back source changed/);
 }
});

test('real registry transitions preserve same-allocation results and drop only reallocated selected units',{skip:skip||(process.platform!=='darwin'?'Native registry fixture uses Darwin image registration.':false)},async t=>{
 const root=projection(t);
 await applyStorageRemapOverlay(root);
 const source=fs.readFileSync(path.join(root,files[1]),'utf8');
 const helper=source.slice(source.indexOf('using AllocationSpans ='),source.indexOf('\n}\n\nvoid StorageTexture::markLayersPending'));
 const pending=source.slice(source.indexOf('        {\n            const auto lease = GuestAllocations::GuestAllocationsAcquireAll_nid_postfix();'),source.indexOf('        layerPending.SetRange(first, count, true);'));
 const writeBack=body(source,'void StorageTexture::writeBackLayers(const std::vector<bool>& layers) {');
 const drop=writeBack.slice(writeBack.indexOf('    {\n        static const bool unregisteredDrop'),writeBack.indexOf('    struct ReleaseReadTrap {'));
 const program=path.join(root,'allocation-lifecycle.cpp'),executable=path.join(root,'allocation-lifecycle');
 fs.writeFileSync(program,`#include "prx/libc/include/GuestAllocations.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <utility>
#include "prx/libc/include/specifics/linux/ElfTypes.hpp"
// The fixture never enumerates guest image pages; the standalone registry still links that API.
extern "C" int dl_iterate_phdr(int (*)(dl_phdr_info*, std::size_t, void*), void*) { return 0; }
using namespace GuestAllocations;
${helper}
std::atomic<unsigned> unregisteredDropped{0};
constexpr std::uint64_t base=0x24af90000, unit=65536;
struct StorageFixture {
 struct { std::uint64_t baseAddress=base; } descriptor;
 std::uint64_t guestBytes=3*unit;
 std::uint32_t trackedLayers=3;
 std::vector<bool> layerPending{false,false,false},layerOriginal{true,true,true},cancelled{false,false,false},stored{false,false,false};
 std::vector<AllocationSpans> pendingBacking{3};
 bool released=false;
 std::uint64_t layerBegin(std::uint32_t layer) { return base+layer*unit; }
 std::uint64_t layerBytes(std::uint32_t) { return unit; }
 void cancelStoredSave(std::uint32_t layer) { cancelled[layer]=true; }
 void releaseReadTraps(bool) { released=true; }
 void mark(std::uint32_t first=0,std::uint32_t count=3) {
${pending}
  for(auto layer=first;layer<first+count;++layer) layerPending[layer]=true;
 }
 void writeBackLayers(const std::vector<bool>& layers) {
${drop}
  for(std::uint32_t layer=0;layer<trackedLayers;++layer) if(layers[layer]) { stored[layer]=true; layerPending[layer]=false; }
  releaseReadTraps(false);
 }
};
#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr,"line %d: %s\\n",__LINE__,#condition); return 1; } } while(0)
void add(std::uint64_t at,std::uint64_t bytes=unit) { Mutation mutation; mutation.Add(reinterpret_cast<void*>(at),bytes,true,true,false); }
void remove(std::uint64_t at) { Mutation mutation; mutation.Remove(reinterpret_cast<void*>(at)); }
AllocationSpans ownership(std::uint64_t at,std::uint64_t bytes=unit) { return UnitBacking(GuestAllocationsAcquireAll_nid_postfix(),at,bytes); }
int main() {
 unsetenv("APS5_NO_UNREGISTERED_DROP");
 add(base); add(base+unit); add(base+2*unit);
 StorageFixture unchanged; unchanged.mark();
 const auto initial=ownership(base);
 const auto backingBefore=[] { return GuestAllocationsLookup_nid_postfix(base,false)->backingSerial; }();
 { Mutation mutation; mutation.Protect(reinterpret_cast<void*>(base+unit/4),unit/2,true,false,false,[]{}); }
 CHECK(ownership(base)==initial);
 CHECK(GuestAllocationsLookup_nid_postfix(base+unit/4,false)->backingSerial!=backingBefore);
 const auto beforeUnpin=GuestAllocationsLookup_nid_postfix(base,false)->backingSerial;
 { Mutation mutation; mutation.RequireUnpinned(reinterpret_cast<void*>(base),unit); }
 CHECK(ownership(base)==initial);
 CHECK(GuestAllocationsLookup_nid_postfix(base,false)->backingSerial!=beforeUnpin);
 unchanged.mark(); CHECK(unchanged.pendingBacking[0]==initial);
 unchanged.writeBackLayers({true,true,true});
 CHECK((unchanged.stored==std::vector<bool>{true,true,true}));
 CHECK((unchanged.cancelled==std::vector<bool>{false,false,false}));
 StorageFixture mixed; mixed.mark();
 remove(base+unit); add(base+unit);
 remove(base+2*unit); add(base+2*unit);
 mixed.mark(); // Already-pending ownership must not be replaced by the new registration.
 CHECK(BackingReallocated(mixed.pendingBacking[1],ownership(base+unit)));
 mixed.writeBackLayers({true,true,false});
 CHECK((mixed.stored==std::vector<bool>{true,false,false}));
 CHECK((mixed.cancelled==std::vector<bool>{false,true,false}));
 CHECK((mixed.layerPending==std::vector<bool>{false,false,true}));
 StorageFixture all; all.mark();
 remove(base); add(base);
 all.writeBackLayers({true,false,false});
 CHECK((all.stored==std::vector<bool>{false,false,false}));
 CHECK(all.cancelled[0]&&all.released&&all.layerPending[1]);
 // An interior replacement must be found even though both endpoint allocations are unchanged.
 const auto old=ownership(base,3*unit);
 remove(base+unit); add(base+unit);
 CHECK(BackingReallocated(old,ownership(base,3*unit)));
 // Losing a registration alone does not claim a new owner; upstream keeps its existing path.
 const auto registered=ownership(base+unit);
 remove(base+unit);
 CHECK(!BackingReallocated(registered,ownership(base+unit)));
 add(base+unit);
 // A protection transition that removes readability keeps the same ownership.
 const auto readable=ownership(base+2*unit);
 { Mutation mutation; mutation.Protect(reinterpret_cast<void*>(base+2*unit),unit,false,false,false,[]{}); }
 CHECK(ownership(base+2*unit)==readable);
 remove(base); remove(base+unit); remove(base+2*unit);
 add(base,3*unit);
 const auto whole=ownership(base,3*unit);
 { Mutation mutation; mutation.Unmap(reinterpret_cast<void*>(base+unit),unit,[](const void*,std::size_t,const void*,bool){}); }
 CHECK(!BackingReallocated(whole,ownership(base,3*unit)));
 CHECK(ownership(base)[0][2]==whole[0][2]&&ownership(base+2*unit)[0][2]==whole[0][2]);
 add(base+unit);
 CHECK(BackingReallocated(whole,ownership(base,3*unit)));
 remove(base); remove(base+unit);
 std::puts("real allocation transitions and selected-unit preservation behave");
}
`);
 const compiler=process.env.CXX||'/usr/bin/clang++';
 const built=spawnSync(compiler,['-std=c++20','-include','utility','-I',path.join(root,'core/libs'),program,path.join(root,files[3]),'-o',executable],{encoding:'utf8',timeout:60000});
 assert.equal(built.status,0,built.stderr);
 const run=spawnSync(executable,[],{encoding:'utf8',timeout:10000});
 assert.equal(run.status,0,run.stdout+run.stderr);
 assert.match(run.stdout,/real allocation transitions and selected-unit preservation behave/);
});
