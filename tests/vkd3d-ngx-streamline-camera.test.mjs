import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..'),producer=path.join(root,'producers/vkd3d-proton');
const headers=path.join(root,'producers/package-support/src/external/streamline-camera/include');
const fixture=String.raw`
#include <cassert>
#include <cstdio>
#include <cstring>
#include "streamline_camera.hpp"
static sl::Constants perspective(bool reversed = false, bool rightHanded = false, bool infinite = false) {
  sl::Constants c{};std::memset(&c.cameraViewToClip, 0, sizeof(c.cameraViewToClip));
  c.cameraNear = .1f;c.cameraFar = infinite ? INFINITY : 1000.f;c.cameraFOV = 1.1f;
  c.orthographicProjection = sl::Boolean::eFalse;c.depthInverted = reversed ? sl::Boolean::eTrue : sl::Boolean::eFalse;
  auto m = &c.cameraViewToClip.row[0].x;
  m[0] = m[5] = 1.f / std::tan(c.cameraFOV / 2);m[11] = rightHanded ? -1.f : 1.f;
  const float farDepth = reversed ? 0.f : 1.f, nearDepth = 1.f - farDepth;
  const float b = infinite ? (nearDepth - farDepth) * c.cameraNear : (nearDepth - farDepth) * c.cameraNear * c.cameraFar / (c.cameraFar - c.cameraNear);
  const float a = nearDepth - b / c.cameraNear;
  m[10] = a * m[11];m[14] = b;return c;
}
int main() {
  RSTemporalCamera result{};unsigned checks = 0;
  for (bool reversed : {false, true}) for (bool rh : {false, true}) for (bool infinite : {false, true}) {
    auto c = perspective(reversed, rh, infinite);assert(ngx_streamline::camera(c, 0, 37, result));checks++;
    assert(result.size == 64 && result.version == 1 && result.frameId == 1 && result.viewportId == 37 && result.frameTimeMs == 0);
    assert(bool(result.flags & RS_TEMPORAL_DEPTH_REVERSED) == reversed && bool(result.flags & RS_TEMPORAL_DEPTH_INFINITE) == infinite);
    assert(infinite ? result.farPlane == 0 : result.farPlane == 1000.f);
    c.structVersion = 1;assert(ngx_streamline::camera(c, UINT32_MAX, 37, result));checks++;assert(result.frameId == uint64_t(UINT32_MAX) + 1);
    c.reset = sl::Boolean::eTrue;c.motionVectorsJittered = sl::Boolean::eTrue;
    assert(ngx_streamline::camera(c, 1, 37, result));checks++;
    assert((result.flags & (RS_TEMPORAL_RESET | RS_TEMPORAL_JITTERED_MOTION)) == (RS_TEMPORAL_RESET | RS_TEMPORAL_JITTERED_MOTION));
    assert(!(result.flags & ~RS_TEMPORAL_CAMERA_FLAGS));
  }
  auto rejected = [&](sl::Constants c) { assert(!ngx_streamline::camera(c, 5, 9, result));assert(result.size == 0);checks++; };
  auto c = perspective();c.cameraNear = 0;rejected(c);c = perspective();c.cameraFOV = NAN;rejected(c);
  c = perspective();c.cameraFOV = 2;rejected(c);c = perspective();c.cameraNear = 1;rejected(c);
  c = perspective();c.depthInverted = sl::Boolean::eTrue;rejected(c);c = perspective();c.orthographicProjection = sl::Boolean::eTrue;rejected(c);
  c = perspective();c.structVersion = 3;rejected(c);c = perspective();c.cameraViewToClip.row[2].x = .5;rejected(c);
  c = perspective();c.cameraFar = FLT_MAX;rejected(c);c = perspective();c.cameraFar = -1;rejected(c);
  c = perspective(false, false, true);c.cameraFar = FLT_MAX;assert(ngx_streamline::camera(c, 5, 9, result));checks++;
  // the viewport of an evaluation: exactly one, also through chains; conflicting or unversioned ones are none
  sl::ViewportHandle a(3), b(4), again(3);uint32_t id = 0;
  const sl::BaseStructure *one[] = {&a};assert(ngx_streamline::viewport(one, 1, id) && id == 3);checks++;
  const sl::BaseStructure *same[] = {&a, &again};assert(ngx_streamline::viewport(same, 2, id) && id == 3);checks++;
  const sl::BaseStructure *two[] = {&a, &b};assert(!ngx_streamline::viewport(two, 2, id));checks++;
  sl::ViewportHandle chained(5);sl::Constants holder{};holder.next = &chained;
  const sl::BaseStructure *chain[] = {&holder};assert(ngx_streamline::viewport(chain, 1, id) && id == 5);checks++;
  assert(!ngx_streamline::viewport(nullptr, 1, id) && !ngx_streamline::viewport(one, 0, id));checks++;
  // cameras by frame and viewport; a frame whose constants failed has none; the oldest is replaced
  ngx_streamline::CameraCache<4> cache;RSTemporalCamera first{}, second{}, out{};
  assert(ngx_streamline::camera(perspective(), 7, 3, first) && ngx_streamline::camera(perspective(true), 7, 4, second));
  cache.remember(7, 3, &first);cache.remember(7, 4, &second);
  assert(cache.lookup(7, 3, out) && out.viewportId == 3 && !(out.flags & RS_TEMPORAL_DEPTH_REVERSED));checks++;
  assert(cache.lookup(7, 4, out) && (out.flags & RS_TEMPORAL_DEPTH_REVERSED));checks++;
  assert(!cache.lookup(8, 3, out));checks++;
  cache.remember(7, 3, nullptr);assert(!cache.lookup(7, 3, out));checks++;
  cache.remember(7, 3, &first);for (uint32_t f = 10; f < 13; ++f) cache.remember(f, 3, &first);
  assert(!cache.lookup(7, 4, out) && cache.lookup(7, 3, out) && cache.lookup(12, 3, out));checks++;
  cache.clear();assert(!cache.lookup(12, 3, out));checks++;
  std::printf("ok %u\n", checks);
}
`;

test('the NGX core selects only valid Streamline perspective cameras, by frame token and viewport',{skip:process.platform==='win32'?'Fixture uses a POSIX compiler.':!fs.existsSync(path.join(headers,'sl_core_types.h'))?'Streamline headers are not checked out.':false},t=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'vkd3d-ngx-camera-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'camera.cpp'),fixture);
 const compiler=process.env.CXX||(fs.existsSync('/usr/bin/clang++')?'/usr/bin/clang++':'c++');
 const built=spawnSync(compiler,['-std=c++20','-O1','-Wall','-Werror','-I'+producer,'-I'+headers,'-o',path.join(directory,'camera'),path.join(directory,'camera.cpp')],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(path.join(directory,'camera'),{encoding:'utf8',timeout:60000});
 assert.equal(ran.status,0,ran.stderr+ran.stdout);
 assert.match(ran.stdout.trim(),/^ok \d+$/);
});

test('the NGX core is built with its Streamline capture, MinHook and the official headers, from declared inputs',()=>{
 const build=fs.readFileSync(path.join(producer,'build.mjs'),'utf8');
 for(const name of ['ngx_streamline.cpp',"'buffer.c','hook.c','trampoline.c','hde/hde64.c'","path.join(streamline,'include')","addLicenses(output,'MinHook',minhook)","addLicenses(output,'Streamline',streamline)"])
  assert(build.includes(name),name);
 const project=JSON.parse(fs.readFileSync(path.join(root,'projects/downloadable.json'),'utf8')).find(row=>row.id==='vkd3d-proton');
 const pins=Object.fromEntries(project.upstreams.map(row=>[row.id,row.pin.gitlink]));
 assert.equal(pins.streamline,'producers/package-support/src/external/streamline-camera');
 assert.equal(pins.minhook,'producers/package-support/src/external/minhook');
 for(const gitlink of [pins.streamline,pins.minhook])assert(project.build.submodules.includes(gitlink),gitlink);
 for(const file of ['ngx_camera.h','ngx_streamline.cpp','streamline_camera.hpp'])assert(project.producer.entries.includes('producers/vkd3d-proton/'+file),file);
 const modules=fs.readFileSync(path.join(root,'.gitmodules'),'utf8');
 assert.match(modules,/path = producers\/package-support\/src\/external\/minhook\n\s*url = https:\/\/github\.com\/TsudaKageyu\/minhook\.git/);
 const patch=fs.readFileSync(path.join(producer,'ngx.patch'),'utf8');
 assert(!/^\+.*MacLauncherSetTemporalCamera/m.test(patch),'the core no longer exports the replaced interposer\'s camera setter');
 assert.equal((patch.match(/^\+  HookStreamline\(\);$/gm)||[]).length,8,'every D3D12 and D3D11 Init installs the capture');
});
