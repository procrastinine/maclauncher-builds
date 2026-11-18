import fs from 'node:fs';
import path from 'node:path';
import template from './x64-template.json' with {type: 'json'};
import {buildInput, llvmMingwInput} from '../../tools/build-input.mjs';
import {declaredSource, run, stageSource} from '../../tools/build-source.mjs';
import {upstreamRevision} from '../../lib/projects.mjs';
import {helperPackage, sha} from '../../tools/helper-package.mjs';
import {addLicenses} from '../../lib/licenses.mjs';
import {appRequire} from '../../tools/app-source.mjs';
import {sourceVersion} from './build.mjs';

const bridge = path.resolve(import.meta.dirname,
  '../package-support/src/modules/crossover/temporal/dxmt/build.mjs');
const native = 'x86_64-unix/winemetal.so';
const original = Object.keys(template.files).filter(file => file !== 'x86_64-windows/d3d11.dll');
const modified = new Map([['x86_64-windows/d3d11.dll', 'D3D11CreateDevice'],
  ['x86_64-windows/dxgi.dll', 'CreateDXGIFactory1']]);

export async function prepare({work}) {
  const source = path.join(work, 'source'), vendor = path.join(work, 'sikarugir');
  const compiler = path.join(work, 'llvm-mingw');
  const revision = upstreamRevision('dxmt', 'dxmt');
  await stageSource(declaredSource('dxmt', 'dxmt'), revision, source);
  const archive = await buildInput(template.archive);
  fs.mkdirSync(vendor);
  const prefix = template.directory + '/';
  run('/usr/bin/tar', ['-xf', archive, '--strip-components', '5', '-C', vendor,
    prefix + 'LICENSE', ...Object.keys(template.files).map(file => prefix + 'wine/' + file)]);
  for (const [file, digest] of Object.entries(template.files))
    if (sha(path.join(vendor, 'wine', file)) !== digest) throw Error('Sikarugir DXMT differs at ' + file);
  const tools = await buildInput(llvmMingwInput());
  fs.mkdirSync(compiler);
  run('/usr/bin/tar', ['-xf', tools, '--strip-components', '1', '-C', compiler]);
  return {work, source, vendor, revision, tools: path.join(compiler, 'bin')};
}

export function compile({prepared}) {
  const compiled = path.join(prepared.work, 'bridge');
  run(process.execPath, [bridge, prepared.source, path.join(prepared.vendor, 'wine'),
    prepared.tools, compiled, '--arch', 'x64']);
  return {compiled};
}

export function assemble({version, output, prepared, compiled}) {
  const builtPayload = path.join(compiled.compiled, 'payload');
  const bridgeManifest = JSON.parse(fs.readFileSync(path.join(builtPayload, 'camera-bridge.json')));
  const payload = path.join(output, 'payload'), wine = path.join(payload, 'wine');
  const {inspectBinary} = appRequire('src/core/binary-arch');
  const {readPeExports} = appRequire('src/modules/shared/runtime/pe-exports');
  fs.mkdirSync(output);
  for (const file of [...original, ...modified.keys()]) {
    const rebuilt = modified.has(file);
    const input = path.join(rebuilt ? builtPayload : path.join(prepared.vendor, 'wine'), file);
    if (sha(input) !== (rebuilt ? bridgeManifest.files[file] : template.files[file]))
      throw Error('DXMT input differs from its declared bytes: ' + file);
    const target = path.join(wine, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(input, target);
    fs.chmodSync(target, file === native ? 0o755 : 0o644);
    const binary = inspectBinary(target);
    if (file === native ? binary.format !== 'macho' || !binary.architectures.includes('x86_64') :
        binary.format !== 'pe' || binary.machine !== 'x86_64')
      throw Error('DXMT has unexpected architecture: ' + file);
    if (rebuilt && !readPeExports(target)?.exports.get(modified.get(file))?.executable)
      throw Error('DXMT is missing its renderer export: ' + file);
  }
  fs.writeFileSync(path.join(wine, 'VERSION'), 'DXMT ' + sourceVersion(prepared.revision) + '\n');
  addLicenses(payload, 'DXMT', prepared.source);
  addLicenses(payload, 'Sikarugir DXMT', prepared.vendor);
  const executableRelative = 'wine/' + native;
  return helperPackage({id: 'dxmt', version, arch: 'x64', output, minimumMacOS: '14.0',
    sourceSha256: sha(path.join(import.meta.dirname, 'build-x64.mjs')), manifestRelative: 'manifest.json',
    rosettaFiles: [executableRelative],
    record: {engine: 'dxmt', platform: 'darwin', executableRelative, upstreamRevision: prepared.revision,
      dependencies: [], windowsArchitecture: 'x86_64', nativeArchitecture: 'x86_64',
      unixCallCount: bridgeManifest.tableCount}});
}
