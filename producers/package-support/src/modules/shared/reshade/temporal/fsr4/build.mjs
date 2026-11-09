import {sourceRevision} from '../../../../../../../../lib/pins.mjs';
const revision=sourceRevision({gitlink:'producers/package-support/src/external/fsr4-metal'});
import {addLicenses} from '../../../../../../../../lib/licenses.mjs';
import {appPath} from '../../../../../../../../tools/app-source.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const here = import.meta.dirname, app = appPath('src/modules/shared/reshade/temporal/fsr4'),
      {adaptHelpers, adaptRuntime} = await import(pathToFileURL(path.join(app, 'adapt-runtime.mjs')).href),
      pin = JSON.parse(await fs.readFile(path.join(app, 'source.json'))),
      lite2 = JSON.parse(await fs.readFile(path.join(here, 'lite2.json'))),
      [ sourceArg, destinationArg, ...flags ] = process.argv.slice(2);
if (!sourceArg || !destinationArg)
  throw Error(
      'Usage: build.mjs SOURCE OUTPUT --tools DIR --lite2-weights FILE [--phase compile|assemble]');
const source = path.resolve(sourceArg),
      destination = path.resolve(destinationArg), options = {};
let phase = null;
for (let i = 0; i < flags.length; i++) {
  if (flags[i] === '--phase' && !phase &&
      [ 'compile', 'assemble' ].includes(flags[i + 1])) {
    phase = flags[++i];
    continue;
  }
  if (!['--tools', '--lite2-weights']
           .includes(flags[i]) ||
      !flags[i + 1] || options[flags[i]])
    throw Error('Unknown or repeated build option.');
  options[flags[i]] = path.resolve(flags[++i]);
}
for (const name of ['--tools', '--lite2-weights'])
  if (!options[name])
    throw Error('Missing ' + name);
const hash = b => createHash('sha256').update(b).digest('hex'),
      run = (command, args, extra = {}) => new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio : 'inherit', ...extra});
        child.on('error', reject);
        child.on('close',
                 code => code === 0
                             ? resolve()
                             : reject(Error(command + ' exited ' + code)));
      });
const work = path.join(destination, 'source'),
      payload = path.join(destination, 'payload');

/** Translate the shaders and models and build the universal provider library. */
async function compile() {
  await fs.mkdir(work, {recursive : true});
  await fs.mkdir(payload, {recursive : true});

  // The provider and the headers it includes compile from one owned directory.
  await fs.mkdir(path.join(work, 'owned'), {recursive : true});
  for (const name of ['provider.mm', '../frame.h', '../payload-files.hpp'])
    await fs.writeFile(path.join(work, 'owned', name),
                       await fs.readFile(path.join(app, name)));

  for (const name of ['src', 'tools', 'third_party'])
    await fs.cp(path.join(source, name), path.join(work, name),
                {recursive : true});
  for (const name of ['dxc', 'spirv-cross', 'spirv-val']) {
    const bytes = await fs.readFile(path.join(options['--tools'], name));
    await fs.mkdir(path.join(work, 'tools/bin'), {recursive : true});
    await fs.writeFile(path.join(work, 'tools/bin', name), bytes, {mode : 0o755});
  }
  const replace = (value, before, after) => {
    if (value.split(before).length !== 2)
      throw Error('FSR4 compiler adaptation changed.');
    return value.replace(before, after);
  };
  let compiler =
      await fs.readFile(path.join(work, 'tools/compile_fsr411.py'), 'utf8');
  compiler =
      replace(compiler, 'digest.update(run(["xcrun", "metal", "--version"]))',
              'digest.update(b"maclauncher-msl-source-v1")');
  compiler = replace(
      compiler,
      '        run(["xcrun", "metal", "-std=macos-metal2.3", optimization, *stage_math,\n             "-c", metal, "-o", air], output / f"{name}.metal.log")\n        run(["xcrun", "metallib", air, "-o", lib_path])',
      '        # Portable MSL is compiled by Metal during resource preparation.');
  compiler = compiler.replaceAll('.metallib', '.metal');
  await fs.writeFile(path.join(work, 'tools/compile_fsr411.py'), compiler);
  const runtime = adaptRuntime(
      await fs.readFile(path.join(work, 'src/fsr411_runtime.h'), 'utf8'));
  await fs.writeFile(path.join(work, 'src/fsr411_runtime.h'), runtime.source);
  await fs.writeFile(path.join(work, 'src/fsr411_helpers.metal'),
                     adaptHelpers(await fs.readFile(
                         path.join(source, 'src/fsr411_helpers.metal'), 'utf8')));
  await fs.writeFile(
      path.join(work, 'src/fsr4_log.h'),
      '#pragma once\nstatic inline void fsr4_logf(const char*,...){}\n');
  const build = path.join(work, 'build');
  await fs.mkdir(build, {recursive : true});
  // The translation tools use only the standard library; a cache inside the
  // output directory keeps uv from writing outside the build.
  const python = (script, args) => run(
      'uv',
      [
        'run', '--offline', '--python', process.env.MACLAUNCHER_GRAPHICS_PYTHON || '3.12', '--no-project',
        path.join(work, script), ...args
      ],
      {
        env : {
          ...process.env,
          UV_CACHE_DIR : path.join(destination, 'uv-cache'),
          FSR4_LOSSY2_WEIGHTS : options['--lite2-weights']
        }
      });
  for (const tier of [ 1080, 2160, 4320 ])
    for (const ultra of [ 0, 1 ])
      for (const profile of pin.profiles) {
        const suffix = ultra ? '_ultraperformance' : '',
              profileSuffix = profile.id === 'exact-fast'
                                  ? ''
                                  : '_' + profile.upstreamProfile,
              native = path.join(
                  build, `fsr411_native_${tier}${suffix}${profileSuffix}`);
        await python('tools/gen_fsr411_native.py', [
          '--tier', String(tier), '--profile', profile.nativeProfile,
          '--preset', ultra ? 'ultraperformance' : 'normal', '--lossy2-weights',
          options['--lite2-weights'], '--outdir', native
        ]);
        for (const depth of [ 0, 1 ])
          for (const low of [ 0, 1 ])
            for (const jitter of [ 0, 1 ])
              for (const exposure of [ 0, 1 ])
                await python('tools/compile_fsr411.py', [
                  '--root',
                  work,
                  '--builddir',
                  build,
                  '--res',
                  String(tier),
                  '--profile',
                  profile.upstreamProfile,
                  '--optimize',
                  '1',
                  '--external-post-cnb',
                  '1',
                  '--post-cnb-alias',
                  '1',
                  '--depth-inverted',
                  String(depth),
                  '--low-res-mv',
                  String(low),
                  '--jittered-mv',
                  String(jitter),
                  '--auto-exposure',
                  String(exposure),
                  '--ultra-performance',
                  String(ultra)
                ]);
      }
  await fs.mkdir(path.join(payload, 'build/libraries'), {recursive : true});
  const copied = new Set();
  for (const dir of await fs.readdir(build)) {
    if (!/^fsr411_\d|^fsr411_native_/.test(dir))
      continue;
    const to = path.join(payload, 'build', dir);
    await fs.mkdir(to, {recursive : true});
    if (/^fsr411_\d/.test(dir)) {
      const manifest =
          JSON.parse(await fs.readFile(path.join(build, dir, 'bindings.json')));
      for (const entry of Object.values(manifest.kernels))
        for (const property of ['library', 'literal_tables']) {
          if (!entry[property])
            continue;
          const bytes =
              await fs.readFile(path.resolve(build, dir, entry[property])),
                name = hash(bytes) + path.extname(entry[property]);
          if (!copied.has(name)) {
            await fs.writeFile(path.join(payload, 'build/libraries', name),
                               bytes);
            copied.add(name);
          }
          entry[property] = '../libraries/' + name;
        }
      await fs.writeFile(path.join(to, 'bindings.json'),
                         JSON.stringify(manifest) + '\n');
    } else
      for (const file of await fs.readdir(path.join(build, dir)))
        if (/\.bin$|^fsr411_native_manifest\.json$/.test(file))
          await fs.copyFile(path.join(build, dir, file), path.join(to, file));
  }
  await fs.mkdir(path.join(payload, 'src'), {recursive : true});
  for (const file
           of ['fsr411_model.h', 'fsr411_helpers.metal', 'fsr411_mpp.metal',
               'fsr411_simd.metal', 'fsr411_reference.metal'])
    await fs.copyFile(path.join(work, 'src', file),
                      path.join(payload, 'src', file));
  await fs.mkdir(path.join(payload, 'third_party/fsr411'), {recursive : true});
  await fs.rm(path.join(payload, 'third_party/fsr411/weights_lossy2.npz'),
              {force : true});
  for (const file of ['initializers.bin', 'initializers-ultraperformance.bin'])
    await fs.copyFile(path.join(work, 'third_party/fsr411', file),
                      path.join(payload, 'third_party/fsr411', file));
  await fs.mkdir(path.join(destination, 'source-inputs'), {recursive : true});
  await fs.copyFile(options['--lite2-weights'],
                    path.join(destination, 'source-inputs/weights_lossy2.npz'));
  for (const arch of ['arm64', 'x86_64'])
    await run('xcrun', [
      'clang++',
      '-std=c++17',
      '-O2',
      '-fobjc-arc',
      '-fvisibility=hidden',
      '-dynamiclib',
      '-arch',
      arch,
      '-mmacosx-version-min=13.0',
      '-Werror=unguarded-availability',
      '-I',
      path.join(work, 'src'),
      path.join(work, 'owned/provider.mm'),
      '-framework',
      'Foundation',
      '-framework',
      'Metal',
      '-install_name',
      '@rpath/libmaclauncher-fsr4.dylib',
      '-o',
      path.join(destination, `fsr4-${arch}.dylib`)
    ]);
  await run('xcrun', [
    'lipo', '-create', path.join(destination, 'fsr4-arm64.dylib'),
    path.join(destination, 'fsr4-x86_64.dylib'), '-output',
    path.join(payload, 'libmaclauncher-fsr4.dylib')
  ]);
  await run('codesign', [
    '--force', '--sign', '-', path.join(payload, 'libmaclauncher-fsr4.dylib')
  ]);
}

/** Add the notices and describe the compiled payload. */
async function assemble() {
  addLicenses(payload,'FSR4',path.join(source,'third_party/fsr411'));
  addLicenses(payload,'FSR4 provider',here);
  const tools = {};
  for (const name of ['dxc', 'spirv-cross', 'spirv-val'])
    tools[name] = hash(await fs.readFile(path.join(options['--tools'], name)));
  const files = [];
  for (const relative of (await fs.readdir(payload, {recursive : true})).sort()) {
    if (relative === 'provider.json')
      continue;
    const file = path.join(payload, relative), stat = await fs.stat(file);
    if (stat.isFile())
      files.push({
        path : relative,
        size : stat.size,
        sha256 : hash(await fs.readFile(file))
      });
  }
  await fs.writeFile(path.join(payload, 'provider.json'), JSON.stringify({
    repository : pin.repository,
    commit : revision,
    model : pin.model,
    license : pin.license,
    minimumMacOS : pin.minimumMacOS,
    architectures : pin.architectures,
    sources : pin.sources.map((row, index) => ({
      ...row,
      commit : sourceRevision({gitlink : 'producers/package-support/src/external/' +
                                         [ 'fsr4-sdk-headers', 'fsr4-sdk-model', 'fsr4-int8' ][index]})
    })),
    supportedProfiles : pin.supportedProfiles,
    profiles : pin.profiles,
    providerABI : 1,
    complete : true,
    resourcePreparation : 1,
    profilesAPI : 1,
    loadMinimumMacOS : '13.0',
    profile : 'exact-fast',
    colorSpace : 'linear',
    maximumOutput : [ 7680, 4320 ],
    library : 'libmaclauncher-fsr4.dylib',
    resolvedPaths : [ 'build/fsr411_native_' ],
    sourceInputs : [ {
      path : 'source-inputs/weights_lossy2.npz',
      size : (await fs.stat(options['--lite2-weights'])).size,
      sha256 : lite2.sha256,
      repository : lite2.repository,
      commit : sourceRevision(lite2),
      sourceUrl : lite2.repository + '/tree/' + sourceRevision(lite2)
    } ],
    tools,
    files
  },
                                                                         null,
                                                                         2) +
                                                              '\n');
  console.log(payload);
}
if (phase !== 'assemble')
  await compile();
if (phase !== 'compile')
  await assemble();
