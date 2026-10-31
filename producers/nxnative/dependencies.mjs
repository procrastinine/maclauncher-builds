import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../..');
const lock = JSON.parse(await fs.readFile(path.join(directory, 'dependencies.json'), 'utf8'));

async function run(program, args, options = {}) {
  try {
    const result = await execute(program, args, { maxBuffer: 32 * 1024 * 1024, ...options });
    if (options.log) await fs.appendFile(options.log, result.stdout + result.stderr);
    return result.stdout.trim();
  } catch (error) {
    if (options.log) await fs.appendFile(options.log, (error.stdout || '') + (error.stderr || ''));
    throw error;
  }
}

async function digest(file, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(await fs.readFile(file)).digest('hex');
}

async function acquire(input, cache) {
  const target = path.join(cache, input.filename);
  const algorithm = input.sha512 ? 'sha512' : 'sha256';
  const expected = input[algorithm];
  try {
    if (await digest(target, algorithm) === expected) return target;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(input.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Dependency download failed (${response.status}): ${input.filename}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== input.bytes || crypto.createHash(algorithm).update(bytes).digest('hex') !== expected)
    throw new Error(`Dependency checksum differs: ${input.filename}`);
  const temporary = target + '.partial';
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, target);
  return target;
}

async function extractTar(archive, destination, selected) {
  await fs.mkdir(destination, { recursive: true });
  const names = (await run('/usr/bin/tar', ['-tf', archive])).split('\n').filter(Boolean);
  if (names.some(name => path.posix.isAbsolute(name) || name.split('/').includes('..')))
    throw new Error('Dependency archive contains an unsafe path');
  await run('/usr/bin/tar', ['-xf', archive, '-C', destination, ...(selected ? [selected] : [])]);
}

async function verifySource(input) {
  const source = path.join(repository, input.path);
  const revision = await run('git', ['-C', source, 'rev-parse', 'HEAD']);
  const origin = await run('git', ['-C', source, 'remote', 'get-url', 'origin']);
  const status = await run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all']);
  const normalize = value => value.replace(/\.git$/, '').replace(/\/$/, '');
  if (revision !== input.revision || normalize(origin) !== normalize(input.repository) || status)
    throw new Error(`Dependency source differs from its pin: ${input.path}`);
  return source;
}

async function copyLicense(source, destination, output, licenses) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  licenses.push(path.relative(output, destination).split(path.sep).join('/'));
}

async function buildTool(tool, { work, output, jobs, licenses }) {
  const source = await verifySource(tool.source);
  const build = path.join(work, 'build', tool.name);
  const log = path.join(work, tool.name + '.log');
  await fs.mkdir(build, { recursive: true });
  const prefix = `-ffile-prefix-map=${source}=/nxnative-tools/${tool.name}`;
  const options = { ...tool.configure, ...(tool.name === 'glslangValidator' ? { Python3_EXECUTABLE: path.join(output, 'python/bin/python3') } : {}), BUILD_TESTING: 'OFF', CMAKE_BUILD_TYPE: 'Release',
    CMAKE_OSX_ARCHITECTURES: 'arm64', CMAKE_OSX_DEPLOYMENT_TARGET: lock.minimumMacOS,
    CMAKE_C_FLAGS: prefix, CMAKE_CXX_FLAGS: prefix, CMAKE_EXE_LINKER_FLAGS: `-Wl,-oso_prefix,${build}/` };
  await run('cmake', ['-S', path.join(source, tool.cmakeSource), '-B', build,
    ...Object.entries(options).map(([name, value]) => `-D${name}=${value}`)], { log });
  await run('cmake', ['--build', build, '--target', tool.target, '--parallel', String(jobs)], { log });
  const destination = path.join(output, 'bin', tool.name);
  await fs.copyFile(path.join(build, tool.executable), destination);
  await fs.chmod(destination, 0o755);
  const dependencies = await run('/usr/bin/otool', ['-L', destination]);
  if (dependencies.split('\n').slice(1).some(line => {
    const library = line.trim().split(' (')[0];
    return library && !library.startsWith('/usr/lib/') && !library.startsWith('/System/Library/');
  })) throw new Error(`Dependency tool has an external native library: ${tool.name}`);
  for (const relative of tool.source.licenseFiles)
    await copyLicense(path.join(source, relative), path.join(output, 'licenses/dependencies', tool.name, path.basename(relative)), output, licenses);
  if (tool.name === 'zstd') {
    const text = await fs.readFile(path.join(source, 'lib/dictBuilder/divsufsort.c'), 'utf8');
    const notice = text.match(/^\/\*[\s\S]*?\*\//)?.[0];
    if (!notice) throw new Error('The compression dictionary license is missing');
    const location = path.join(output, 'licenses/dependencies/zstd/DIVSUFSORT_LICENSE.txt');
    await fs.writeFile(location, notice + '\n');
    licenses.push(path.relative(output, location).split(path.sep).join('/'));
  }
  return { id: tool.name, ...tool.source, executable: `bin/${tool.name}`, sha256: await digest(destination) };
}

const installWheels = String.raw`
import json, os, pathlib, stat, sys, zipfile
root, cache, license_root, rows = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), json.loads(sys.argv[4])
for row in rows:
    with zipfile.ZipFile(cache / row['filename']) as archive:
        for entry in archive.infolist():
            name = pathlib.PurePosixPath(entry.filename)
            if name.is_absolute() or '..' in name.parts or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Unsafe wheel path')
            if entry.is_dir(): continue
            parts = name.parts
            if parts[0].endswith('.data'):
                if len(parts) < 3 or parts[1] not in ('purelib', 'platlib'):
                    continue
                parts = parts[2:]
            target = root.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(entry))
            target.chmod((entry.external_attr >> 16) & 0o777 or 0o644)
        for relative in row['licenseFiles']:
            target = license_root / row['name'] / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(relative))
`;

async function prunePython(root, excludedReason) {
  const excluded = lock.python.exclude;
  async function visit(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      const file = path.join(directory, entry.name);
      if (excluded.includes(name) || excludedReason(name) || entry.name === '__pycache__' || entry.name.endsWith('.pyc') || entry.name.endsWith('.a')) {
        await fs.rm(file, { recursive: true, force: true });
      } else if (entry.isDirectory()) await visit(file, name);
    }
  }
  await visit(root);
}

async function finalizePayload(root, excludedReason) {
  const realRoot = await fs.realpath(root);
  async function visit(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      const file = path.join(directory, entry.name);
      const license = name === 'licenses' || name.startsWith('licenses/');
      if (!license && (excludedReason(name) || entry.name === '__pycache__' || /\.(?:pyc|pdb)$/i.test(entry.name))) {
        await fs.rm(file, { recursive: true, force: true });
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(file);
        const inside = path.relative(realRoot, target);
        if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside))
          throw new Error('Dependency alias leaves the payload');
        const stat = await fs.stat(target);
        if (stat.isFile()) {
          await fs.unlink(file);
          await fs.copyFile(target, file, fsConstants.COPYFILE_FICLONE);
          await fs.chmod(file, stat.mode & 0o777);
        } else if (stat.isDirectory()) {
          if (file.startsWith(target + path.sep)) throw new Error('Dependency alias contains a directory cycle');
          const temporary = file + '.flatten';
          await fs.cp(target, temporary, { recursive: true, verbatimSymlinks: true });
          await fs.unlink(file);
          await fs.rename(temporary, file);
          await visit(file, name);
        } else throw new Error('Dependency alias does not name a regular payload');
      } else if (entry.isDirectory()) await visit(file, name);
      else if (!entry.isFile()) throw new Error('Dependency payload contains a special file');
    }
  }
  await visit(root);
}

export async function prepareDependencies({ work, output, jobs = 4 }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('nxnative dependencies require an Apple Silicon build host');
  work = path.resolve(work);
  output = path.resolve(output);
  if (work === output || work.startsWith(output + path.sep) || output === path.parse(output).root)
    throw new Error('Dependency work and payload directories must be separate');
  const require = createRequire(import.meta.url);
  const { excludedReason } = require(path.join(repository, lock.payloadPolicy));
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(path.join(work, 'wheels'), { recursive: true });
  await fs.mkdir(path.join(output, 'bin'), { recursive: true });
  const licenses = [];
  const [pythonArchive, dotnetArchive, pythonLicenseArchive] = await Promise.all([
    acquire(lock.python, work), acquire(lock.dotnet, work), acquire(lock.python.licenseArchive, work),
    ...lock.wheels.map(wheel => acquire(wheel, path.join(work, 'wheels')))
  ]);
  const pythonStage = path.join(work, 'python-extract');
  await fs.rm(pythonStage, { recursive: true, force: true });
  await extractTar(pythonArchive, pythonStage);
  const pythonRoot = path.join(output, 'python');
  await fs.rm(pythonRoot, { recursive: true, force: true });
  await fs.cp(path.join(pythonStage, 'python'), pythonRoot, { recursive: true, verbatimSymlinks: true });
  const python = path.join(pythonRoot, 'bin/python3');
  if ((await fs.lstat(python)).isSymbolicLink()) {
    const target = await fs.realpath(python);
    const mode = (await fs.stat(target)).mode;
    await fs.unlink(python);
    await fs.copyFile(target, python, fsConstants.COPYFILE_FICLONE);
    await fs.chmod(python, mode & 0o777);
  }
  const wheelLicenses = path.join(output, 'licenses/dependencies/python-wheels');
  await run(python, ['-B', '-I', '-c', installWheels, path.join(pythonRoot, 'lib/python3.12/site-packages'), path.join(work, 'wheels'), wheelLicenses, JSON.stringify(lock.wheels)]);
  await prunePython(pythonRoot, excludedReason);
  const licenseStage = path.join(work, 'python-license-extract');
  await fs.rm(licenseStage, { recursive: true, force: true });
  await extractTar(pythonLicenseArchive, licenseStage, lock.python.licenseArchive.path);
  const pythonLicenseSource = path.join(licenseStage, lock.python.licenseArchive.path);
  for (const relative of await fs.readdir(pythonLicenseSource))
    await copyLicense(path.join(pythonLicenseSource, relative), path.join(output, 'licenses/dependencies/python', relative), output, licenses);
  for (const wheel of lock.wheels) for (const relative of wheel.licenseFiles)
    licenses.push(path.posix.join('licenses/dependencies/python-wheels', wheel.name, relative));
  const dotnetRoot = path.join(output, 'dotnet');
  await fs.rm(dotnetRoot, { recursive: true, force: true });
  await extractTar(dotnetArchive, dotnetRoot);
  for (const relative of lock.dotnet.licenseFiles)
    await copyLicense(path.join(dotnetRoot, relative), path.join(output, 'licenses/dependencies/dotnet', relative), output, licenses);
  await run(python, ['-B', '-I', '-c', 'import sys,lz4.block,capstone,fontTools,backports.zstd,nsz,zstandard; from Crypto.Cipher import AES; assert sys.version_info[:3] == (3,12,15)']);
  const dotnet = await run(path.join(dotnetRoot, 'dotnet'), ['--list-runtimes'], {
    env: { ...process.env, DOTNET_ROOT: dotnetRoot, DOTNET_ROOT_ARM64: dotnetRoot, DOTNET_MULTILEVEL_LOOKUP: '0', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' }
  });
  if (!dotnet.includes('Microsoft.NETCore.App ' + lock.dotnet.version + ' [')) throw new Error('The .NET runtime version differs from its input');
  const perToolJobs = Math.max(1, Math.floor(Math.max(1, Number(jobs) || 1) / lock.tools.length));
  const tools = await Promise.all(lock.tools.map(tool => buildTool(tool, { work, output, jobs: perToolJobs, licenses })));
  await finalizePayload(output, excludedReason);
  await fs.rm(pythonStage, { recursive: true, force: true });
  await fs.rm(licenseStage, { recursive: true, force: true });
  return { schemaVersion: 1, architecture: lock.architecture, minimumMacOS: lock.minimumMacOS,
    inputs: [{ id: 'python', ...lock.python }, { id: 'dotnet', ...lock.dotnet }, ...lock.wheels.map(wheel => ({ id: 'python:' + wheel.name, ...wheel })), ...tools],
    licenses: licenses.sort(), tools: { python: 'python/bin/python3', dotnet: 'dotnet/dotnet', spirvCross: 'bin/spirv-cross', glslang: 'bin/glslangValidator', zstd: 'bin/zstd' } };
}
