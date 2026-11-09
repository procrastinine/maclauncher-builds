#!/usr/bin/env node
import {addLicenses} from '../../../../../../../lib/licenses.mjs';
import {sourceRevision as recordRevision} from '../../../../../../../lib/pins.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath,pathToFileURL } from 'node:url';
import {appPath} from '../../../../../../../tools/app-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [upstreamArg, vendorArg, compilerArg, outputArg] = process.argv.slice(2);
const nativeOnly = process.argv.includes('--native-only');
if (!outputArg) throw new Error('Usage: build.mjs DXMT_SOURCE DXMT_WINE_DIRECTORY LLVM_MINGW_BIN OUTPUT [--native-only]');
const [upstream, vendor, toolchain, output] = [upstreamArg, vendorArg, compilerArg, outputArg].map(p => path.resolve(p));
const owned=appPath('src/modules/crossover/temporal/dxmt');
const {applyCameraOverlay}=await import(pathToFileURL(path.join(owned,'patch.mjs')));
const {applyTemporalD3D12}=await import(pathToFileURL(path.join(owned,'d3d12-overlay.mjs')));
const revision = recordRevision(JSON.parse(fs.readFileSync(path.join(here, 'source.json'), 'utf8')));
// --phase compile copies, adapts and compiles DXMT; --phase assemble writes the licenses and
// camera-bridge.json from the compiled payload and the declared inputs alone. Without --phase both run.
const phase=process.argv.includes('--phase')?process.argv[process.argv.indexOf('--phase')+1]:null;
const source = path.join(output, 'source'), objects = path.join(output, 'objects'), payload = path.join(output, 'payload');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const vendorPE = path.join(vendor, 'x86_64-windows'), vendorUnix = path.join(vendor, 'x86_64-unix/winemetal.so');
// The unchanged portable command library is taken from the installed renderer.
// This does not rebuild its shader compiler or introduce a Metal toolchain at play.
function commandLibraries(){
 const original = fs.readFileSync(path.join(vendorPE, 'd3d11.dll'));
 const libs = [];
 for (let at = original.indexOf('MTLB'); at >= 0; at = original.indexOf('MTLB', at + 4)) {
  if (at + 24 > original.length) continue;
  const length = Number(original.readBigUInt64LE(at + 16));
  if (length >= 100 && length < original.length - at) libs.push(original.subarray(at, at + length));
 }
 return libs;
}
// The adaptation leaves the Unix call table as upstream declares it.
function tableCount(){
 const unixSource = fs.readFileSync(path.join(upstream, 'src/winemetal/unix/winemetal_unix.c'), 'utf8');
 const table = unixSource.match(/const void \*__wine_unix_call_funcs\[\] = \{([\s\S]+?)\};/)[1];
 return table.split(',').filter(s => s.trim()).length;
}
const unixOut = path.join(payload, 'x86_64-unix/winemetal.so');
/** Copy, adapt and compile DXMT into the payload. */
async function compile(){
fs.mkdirSync(output, { recursive: true });
fs.cpSync(upstream, source, { recursive: true, filter: p => !p.split(path.sep).includes('.git') });
fs.mkdirSync(objects, { recursive: true });
for (const arch of ['x86_64-windows', 'x86_64-unix']) fs.mkdirSync(path.join(payload, arch), { recursive: true });
const shared = appPath('src/modules/shared/reshade/temporal');
for (const file of ['camera.h', 'frame.h']) fs.copyFileSync(path.join(shared, file), path.join(source, 'include', file));
for(const file of ['camera-transport.hpp','streamline-transport.hpp','streamline-native.h','streamline-snapshot.hpp'])fs.copyFileSync(path.join(owned,file),path.join(source,'include',file));
for(const [name,file]of [['scene-aovs.h',path.join(shared,'scene-aovs.h')],['image-color.h',path.resolve(shared,'../native/image-color.h')]])fs.copyFileSync(file,path.join(source,'include',name));
applyCameraOverlay(source);
applyTemporalD3D12(source);
fs.writeFileSync(path.join(source, 'include/version.h'), `#pragma once\n#define DXMT_VERSION "v0.80-244-g7c8dee1-maclauncher-camera1"\n`);
if (nativeOnly) {
  const previous = JSON.parse(fs.readFileSync(path.join(payload, 'camera-bridge.json'), 'utf8'));
  if (previous.temporalD3D12API!==1 || ['d3d11', 'd3d12', 'dxgi', 'nvngx'].some(name => {
    const file = 'x86_64-windows/' + name + '.dll';return sha(path.join(payload, file)) !== previous.files?.[file];
  })) throw new Error('Native-only builds require the unchanged PE libraries from an existing complete build.');
}
const libs = commandLibraries();
fs.writeFileSync(path.join(output, 'dxmt_command.metallib'), libs[0]);
execFileSync('xxd', ['-n', 'dxmt_command', '-i', path.join(output, 'dxmt_command.metallib'), path.join(source, 'include/dxmt_command.h')]);

const cc = path.join(toolchain, 'x86_64-w64-mingw32-clang');
const cxx = path.join(toolchain, 'x86_64-w64-mingw32-clang++');
const ar = path.join(toolchain, 'llvm-ar');
const readobj = path.join(toolchain, 'llvm-readobj');
const imports = execFileSync(readobj, ['--coff-exports', path.join(vendorPE, 'winemetal.dll')], { encoding: 'utf8' });
const exportNames = [...imports.matchAll(/^  Name: (.+)$/gm)].map(m => m[1]);
const def = path.join(objects, 'winemetal.def');
fs.writeFileSync(def, `LIBRARY winemetal.dll\nEXPORTS\n${exportNames.join('\n')}\n`);
const wineImport = path.join(objects, 'libwinemetal.a');
execFileSync(path.join(toolchain, 'x86_64-w64-mingw32-dlltool'), ['-d', def, '-l', wineImport]);

const include = ['include', 'libs', 'src/util', 'src/airconv', 'src/winemetal', 'src/dxmt', 'src/dxgi', 'src/d3d11','src/d3d12'].map(p => '-I' + path.join(source, p));
const common = ['-O2', '-DNDEBUG', '-DNOMINMAX', '-D_WIN32_WINNT=0xa00', '-DDXMT_PAGE_SIZE=4096',
  '-fblocks', '-Wno-unused-parameter', '-Wno-unused-private-field', '-Wno-missing-field-initializers',
  '-Wno-microsoft-exception-spec', '-Wno-extern-c-compat', '-Wno-missing-braces',
  '-ffile-prefix-map=' + source + '=dxmt', ...include];
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(log) : reject(new Error(`${exe} ${args.join(' ')}\n${log}`)));
  });
}
function list(dir, variable) {
  const meson = fs.readFileSync(path.join(source, dir, 'meson.build'), 'utf8');
  const start = meson.indexOf(variable + ' = '), begin = meson.indexOf('[', start), end = meson.indexOf(']', begin);
  if (start < 0) throw new Error(`Missing source list ${variable}`);
  return [...meson.slice(begin, end).split('\n').filter(s => !s.trim().startsWith('#')).join('\n').matchAll(/'([^']+\.(?:cpp|c))'/g)]
      .map(m => path.normalize(path.join(dir, m[1])));
}
const groups = {
  util: [...list('src/util', 'util_src'), 'src/util/wsi_monitor_win32.cpp', 'src/util/wsi_window_win32.cpp', 'src/util/wsi_platform_win32.cpp'],
  dxbc: list('libs/DXBCParser', 'dxbc_parser_src'),
  dxmt: list('src/dxmt', 'dxmt_src'),
  dxgi: list('src/dxgi', 'dxgi_src'),
  d3d11: [...list('src/d3d11', 'd3d11_src'), ...list('src/d3d11', 'd3d10_src')],
  nvngx: list('src/nvngx', 'nvngx_src'),
  d3d12:list('src/d3d12','d3d12_src'),
};
const all = [...new Set(Object.values(groups).flat())];
const objectFor = file => path.join(objects, file.replaceAll('/', '_') + '.o');
let cursor = 0;
if (!nativeOnly) {
await Promise.all(Array.from({ length: Math.min(2, os.availableParallelism()) }, async () => {
  while (cursor < all.length) {
    const file = all[cursor++], c = file.endsWith('.c');
    await run(c ? cc : cxx, [...common, ...(c ? [] : ['-std=c++20']), '-c', path.join(source, file), '-o', objectFor(file)]);
  }
}));
const archive = name => path.join(objects, 'lib' + name + '.a');
for (const name of ['util', 'dxbc', 'dxmt']) execFileSync(ar, ['rcs', archive(name), ...groups[name].map(objectFor)]);
const outPE = path.join(payload, 'x86_64-windows');
for (const name of ['dxgi', 'd3d11', 'd3d12', 'nvngx']) {
  const dll = path.join(outPE, name + '.dll');
  const args = ['-shared', '-static', '-Wl,--file-alignment=4096', '-Wl,--no-insert-timestamp', '-Wl,--out-implib,' + archive(name), '-o', dll,
    ...groups[name].map(objectFor)];
  if (name !== 'nvngx') args.push(path.join(source, 'src', name, name + '.def'));
  else args.push('-Wl,--export-all-symbols');
  if (name !== 'dxgi') args.push(archive('dxgi'));
  args.push(archive('dxmt'), archive('dxbc'), archive('util'), wineImport, '-ldxguid', '-ld3dcompiler', '-luser32', '-lgdi32', '-ladvapi32', '-lsetupapi');
  await run(cxx, args);
  execFileSync(path.join(toolchain, 'llvm-strip'), ['--strip-unneeded', dll]);
  // Wine's builtin marker is in the unused DOS stub, leaving the PE image intact.
  const data = fs.readFileSync(dll);
  if (data.readUInt32LE(0x3c) < 80) throw new Error('PE image has no builtin marker space.');
  data.write('Wine builtin DLL\0', 64, 'ascii'); fs.writeFileSync(dll, data);
}
}

if(!nativeOnly){
 const exported=name=>execFileSync(readobj,['--coff-exports',path.join(payload,'x86_64-windows',name+'.dll')],{encoding:'utf8'});
 for(const [dll,names]of [['d3d12',['MacLauncherDXMTTemporalUpscale12','MacLauncherDXMTReleaseTemporal12','MacLauncherDXMTTemporal12Supported']],['nvngx',['NVSDK_NGX_D3D12_CreateFeature','NVSDK_NGX_D3D12_EvaluateFeature','NVSDK_NGX_D3D12_ReleaseFeature']]]){
  const text=exported(dll);for(const name of names)if(!text.includes('Name: '+name+'\n'))throw Error('Missing D3D12 temporal producer export: '+name);
 }
}
const count = tableCount();
await run('xcrun', ['clang', '-x','objective-c','-fblocks','-arch', 'x86_64', '-mmacosx-version-min=13.0', '-std=c2x', '-dynamiclib', '-O2',
  '-DML_UNIX_CALL_COUNT=' + count, ...include, '-Wl,-install_name,@rpath/winemetal.so',
  path.join(owned, 'unix-forwarder.c'),'-framework','Foundation','-framework','Metal','-framework','MetalFX', '-o', unixOut]);
execFileSync('codesign', ['--force', '--sign', '-', unixOut], { stdio: 'pipe' });
}
/** Write the licenses and camera-bridge.json from the compiled payload and the declared inputs. */
function assemble(){
addLicenses(payload,'DXMT',upstream);
const files = {};
for (const file of fs.readdirSync(path.join(payload,'x86_64-windows')).filter(name=>name.endsWith('.dll'))) files['x86_64-windows/'+file]=sha(path.join(payload,'x86_64-windows',file));
files['x86_64-unix/winemetal.so'] = sha(unixOut);
fs.writeFileSync(path.join(payload, 'camera-bridge.json'), JSON.stringify({
  schema: 1, id: 'dxmt-camera1', resourceTagAPI:1,resourceSnapshotAPI:1,temporalD3D12API:1,source: { url: 'https://github.com/3Shain/dxmt', revision },
  architecture: 'x86_64', minimumMacOS: '14.0.0', tableCount: tableCount(),
  base: { nativeSha256: sha(vendorUnix), thunkSha256: sha(path.join(vendorPE, 'winemetal.dll')),
    commandLibrarySha256: crypto.createHash('sha256').update(commandLibraries()[0]).digest('hex') }, files,
}, null, 2) + '\n');
}
if(phase!=='assemble')await compile();
if(phase!=='compile')assemble();
console.log(payload);
