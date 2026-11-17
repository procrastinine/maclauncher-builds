// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {source, applyProfile} from './overlay.mjs';
import {sceneWindowInputs} from './scene-window.mjs';
import {buildInput, llvmMingwInput} from '../../tools/build-input.mjs';
import crossoverWine from '../dependencies/crossoverWine.json' with {type:'json'};
import {recipeMain} from '../../tools/build-source.mjs';
import {helperPackage} from '../../tools/helper-package.mjs';
import {addLicenses, addLicense} from '../../lib/licenses.mjs';
import {reproducibleEnvironment, buildToolchain} from '../../lib/reproducible-build.mjs';
const here = import.meta.dirname;
const sourceArchive = crossoverWine, toolchain = llvmMingwInput();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, {stdio:'inherit', ...options});
const read = (command, args, options = {}) => execFileSync(command, args, {encoding:'utf8', ...options}).trim();
// Inherit an existing compiler priority; raise niceness only as far as 19.
const runBuild = (command, args, options = {}) => {
 const increment = Math.max(0, 19 - os.getPriority());
 return increment ? run('/usr/bin/nice', ['-n', String(increment), command, ...args], options) : run(command, args, options);
};
const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
async function extract(input, cache, destination, members) {
 const archive = await buildInput(input, cache);
 fs.mkdirSync(destination, {recursive:true});
 run('/usr/bin/tar', ['-xf', archive, '--no-same-owner', '-C', destination, ...(members || [])]);
 return archive;
}
async function bison(work, cache, environment) {
 const root = path.join(work, 'bison'), output = path.join(root, 'output'), executable = path.join(output, 'bin/bison');
 if (!fs.existsSync(executable)) {
  await extract(source.bison, cache, root);
  const build = path.join(root, 'build'); fs.mkdirSync(build, {recursive:true});
  runBuild('/bin/sh', [path.join(root, source.bison.directory, 'configure'), '--prefix=' + output, '--disable-nls'], {cwd:build, env:environment});
  runBuild('make', ['-j2', 'install'], {cwd:build, env:environment});
 }
 if (!read(executable, ['--version']).startsWith('bison (GNU Bison) ' + source.bison.version))
  throw Error('The declared Bison version differs.');
 return executable;
}
export async function buildWinemac({output, work, arch = 'x64', prepareOnly = false}) {
 if (arch !== 'x64') throw Error('This CrossOver Unix ABI uses x86_64.');
 work = path.resolve(work); if (/\s/.test(work)) throw Error('Wine requires a work path without whitespace.');
 output = path.resolve(output); if (fs.existsSync(output)) throw Error('The package output already exists.');
 const cache = path.join(work, 'downloads'), directory = path.join(work, 'source'), build = path.join(work, 'build');
 fs.mkdirSync(work, {recursive:true});
 const archive = await buildInput(sourceArchive, cache);
 const inputs = Object.fromEntries(['source.json', 'overlay.mjs', 'surface-lifetime.mjs', 'build.mjs', ...sceneWindowInputs].map(file => [file, sha(fs.readFileSync(path.join(here, file)))]));
 const key = sha(JSON.stringify(inputs)), receipt = path.join(work, 'source-inputs.json');
 let adaptation;
 if (fs.existsSync(receipt)) {
  const prior = JSON.parse(fs.readFileSync(receipt));
  if (['source.json', 'overlay.mjs', 'surface-lifetime.mjs', ...sceneWindowInputs].some(file => prior.inputs[file] !== inputs[file]) ||
      prior.adaptation.adaptedSha256 !== sha(fs.readFileSync(path.join(directory, source.original.file))) ||
      !prior.adaptation.sceneWindow || prior.adaptation.sceneWindow.files.some(file =>
       !fs.existsSync(path.join(directory, file.file)) || file.adaptedSha256 !== sha(fs.readFileSync(path.join(directory, file.file)))))
   throw Error('The prepared source differs; use a new work directory.');
  adaptation = prior.adaptation;
 } else {
  if (fs.existsSync(directory)) throw Error('The source directory has no matching receipt.');
  fs.mkdirSync(directory);
  run('/usr/bin/tar', ['-xf', archive, '--no-same-owner', '--strip-components=2', '-C', directory, sourceArchive.directory]);
  adaptation = applyProfile(directory); write(receipt, {key, inputs, adaptation});
 }
 if (prepareOnly) return {directory, adaptation};
 const environment = reproducibleEnvironment();
 const [compilerArchive, linkArchive] = await Promise.all([
  buildInput(toolchain, cache), buildInput(source.vulkanLinkInput.archive, cache)]);
 const toolRoot = path.join(work, 'toolchain'), compiler = path.join(toolRoot, toolchain.directory, 'bin');
 if (!fs.existsSync(compiler)) { fs.mkdirSync(toolRoot, {recursive:true}); run('/usr/bin/tar', ['-xf', compilerArchive, '-C', toolRoot]); }
 const bisonExecutable = await bison(work, cache, environment);
 const linkRoot = path.join(work, 'vulkan-link');
 if (!fs.existsSync(path.join(linkRoot, source.vulkanLinkInput.file)))
  await extract(source.vulkanLinkInput.archive, cache, linkRoot, [source.vulkanLinkInput.file]);
 const library = path.join(linkRoot, source.vulkanLinkInput.file);
 if (sha(fs.readFileSync(library)) !== source.vulkanLinkInput.sha256) throw Error('The Vulkan link probe differs from its exact release.');
 const sdk = read('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']), cc = read('/usr/bin/xcrun', ['--find', 'clang']);
 const wrapper = path.join(work, 'clang-x86_64');
 fs.writeFileSync(wrapper, '#!/bin/sh\nexec ' + [cc, '-arch', 'x86_64', '-isysroot', sdk, '-mmacosx-version-min=' + source.minimumMacOS].map(quote).join(' ') + ' "$@"\n', {mode:0o755});
 const flags = '-O2 -g0 ' + [...new Set([work, fs.realpathSync(work)])].map(root => '-ffile-prefix-map=' + root + '=WineSource').join(' ');
 Object.assign(environment, {CC:wrapper, SDKROOT:sdk, MACOSX_DEPLOYMENT_TARGET:source.minimumMacOS,
  PATH:compiler + path.delimiter + path.dirname(bisonExecutable) + path.delimiter + process.env.PATH,
  CFLAGS:flags, CPPFLAGS:'', LDFLAGS:'-L' + path.dirname(library), BISON:bisonExecutable});
 fs.mkdirSync(build, {recursive:true});
 if (!fs.existsSync(path.join(build, 'Makefile')))
  runBuild('/usr/bin/arch', ['-x86_64', '/bin/sh', path.join(directory, 'configure'), '--host=x86_64-apple-darwin', '--enable-archs=x86_64',
   '--disable-tests', '--without-x', '--without-freetype', '--cache-file=config.cache'], {cwd:build, env:environment});
 runBuild('make', ['-j2', 'dlls/winemac.drv/winemac.so'], {cwd:build, env:environment});
 const native = path.join(build, 'dlls/winemac.drv/winemac.so');
 run('/usr/bin/lipo', [native, '-verify_arch', 'x86_64']);
 const nativeInterfaces = {sceneWindow:{abi:source.sceneWindow.abi, entryPoint:source.sceneWindow.entryPoint}};
 const payload = path.join(output, 'payload'), relative = 'x86_64-unix/winemac.so', binary = path.join(payload, relative);
 fs.mkdirSync(path.dirname(binary), {recursive:true}); fs.copyFileSync(native, binary); fs.chmodSync(binary, 0o755);
 run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', binary]);
 const provenance = {schemaVersion:1, source:sourceArchive, runtimeProfile:source.runtimeProfile, adaptation, producerInputs:inputs,
  toolchain:buildToolchain(environment), bisonVersion:source.bison.version, compiler:toolchain, vulkanLinkInput:source.vulkanLinkInput,
  configure:['--host=x86_64-apple-darwin','--enable-archs=x86_64','--disable-tests','--without-x','--without-freetype'],
  target:'dlls/winemac.drv/winemac.so', pePartsChanged:false};
 write(path.join(payload, 'provenance.json'), provenance);
 addLicenses(payload, 'Wine', directory);
 addLicense(payload, 'Wine authors', path.join(directory, 'AUTHORS'));
 return helperPackage({id:source.id, version:source.version, arch:'x64', output, minimumMacOS:source.minimumMacOS,
  sourceSha256:sha(JSON.stringify(inputs)), manifestRelative:'manifest.json', rosettaFiles:[relative],
  record:{provider:source.id, role:source.role, optional:source.optional, runtimeProfile:source.runtimeProfile,
   wineVulkanDriverVersion:source.runtimeProfile.wineVulkanDriverVersion, libraries:{'x86_64-unix':relative},
   capabilities:{role:source.role, optional:source.optional, runtimeProfile:source.runtimeProfile, libraries:{'x86_64-unix':relative}, nativeInterfaces}, dependencies:[]}});
}
recipeMain(import.meta, buildWinemac);
