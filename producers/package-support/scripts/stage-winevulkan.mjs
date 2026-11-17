import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safe = name => typeof name === 'string' && name.length > 0 && !path.posix.isAbsolute(name) &&
  !name.includes('\\') && !name.split('/').some(part => !part || part === '.' || part === '..');
const inside = (root, file) => file.startsWith(root + path.sep);

// A completed Wine module supplies its own inventory and ABI profile. Its
// signed native bytes are preserved when included in the graphics component.
export function stageWineVulkan(directory) {
  const root = fs.realpathSync(directory), manifestFile = path.join(root, 'manifest.json');
  const read = (file, maximum) => {
    const parts = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
    let parent = root;
    for (const part of parts) {
      parent = path.join(parent, part);const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('WineVulkan module folders must not use aliases.');
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || !inside(root, fs.realpathSync(file)))
      throw Error('WineVulkan module inputs must be regular files inside the completed payload.');
    return fs.readFileSync(file);
  };
  const manifestBytes = read(manifestFile, 4 * 1024 * 1024), manifest = JSON.parse(manifestBytes), provider = manifest.provider;
  if (manifest.schemaVersion !== 1 || provider?.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length ||
      manifest.files.length > 20000 || !Array.isArray(provider.files) || !provider.libraries || typeof provider.libraries !== 'object' ||
      Array.isArray(provider.libraries) || !Array.isArray(provider.runtimeProfile?.files) || !provider.runtimeProfile.files.length ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(provider.minimumMacOS || ''))
    throw Error('A complete WineVulkan module with an exact installed Wine profile is required.');
  const profileNames = new Set();
  for (const row of provider.runtimeProfile.files) {
    if (!safe(row?.relative) || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || profileNames.has(row.relative))
      throw Error('The WineVulkan installed Wine profile is invalid.');
    profileNames.add(row.relative);
  }
  const files = new Map(), records = new Map(), base = 'temporal/vulkan/';
  for (const row of manifest.files) {
    if (!safe(row?.path) || ['manifest.json', 'selection.json', 'module-manifest.json'].includes(row.path) || records.has(base + row.path) ||
        !Number.isSafeInteger(row.size) || row.size < 0 || !/^[a-f0-9]{64}$/.test(row.sha256 || ''))
      throw Error('The WineVulkan module inventory is invalid.');
    const file = path.join(root, row.path), bytes = read(file, 128 * 1024 * 1024);
    if (bytes.length !== row.size || digest(bytes) !== row.sha256) throw Error('A WineVulkan module input differs from its completed manifest: ' + row.path);
    files.set(base + row.path, file);records.set(base + row.path, structuredClone(row));
  }
  const providerNames = new Set();
  if (provider.files.length !== manifest.files.length || provider.files.some(row => {
    const recorded = records.get(base + row.path);
    const duplicate = providerNames.has(row.path);providerNames.add(row.path);
    return duplicate || !recorded || row.sha256 !== recorded.sha256 || row.size !== recorded.size || row.format !== recorded.format ||
      JSON.stringify(row.architectures) !== JSON.stringify(recorded.architectures);
  })) throw Error('The WineVulkan provider and module inventories differ.');
  const libraries = new Map();
  for (const [folder, relative] of Object.entries(provider.libraries)) {
    if (!/^[a-z0-9_]+-(?:unix|windows)$/.test(folder) || !safe(relative) || path.posix.dirname(relative) !== folder || !records.has(base + relative))
      throw Error('The WineVulkan library declaration is invalid.');
    libraries.set(folder, relative);
  }
  const pairs = [];
  for (const [folder, native] of libraries) {
    if (!folder.endsWith('-unix')) continue;
    const client = libraries.get(folder.slice(0, -5) + '-windows');
    if (!client) continue;
    const nativeRecord = records.get(base + native), clientRecord = records.get(base + client);
    if (nativeRecord.format !== 'mach-o' || clientRecord.format !== 'pe' || !native.endsWith('.so') || !client.endsWith('.dll') ||
        !Array.isArray(nativeRecord.architectures) || !nativeRecord.architectures.length ||
        !Array.isArray(clientRecord.architectures) || !clientRecord.architectures.length)
      throw Error('The WineVulkan pair lacks its measured library identities.');
    pairs.push({ client: {file: base + client, sha256: clientRecord.sha256}, native: {file: base + native, sha256: nativeRecord.sha256},
      runtimeProfile: structuredClone(provider.runtimeProfile) });
  }
  if (!pairs.length) throw Error('The WineVulkan module has no complete owned-name client/native pair.');
  const componentMetadata = new Map([...records].map(([name, row]) => [name, row.format === 'mach-o'
    ? {format: row.format, architectures: row.architectures,
      optionalLoad: {architectures: row.architectures, minimumMacOS: provider.minimumMacOS}}
    : {}]));
  return { files, records, componentMetadata, provider, manifestFile, generated: new Map([
    [base + 'module-manifest.json', manifestBytes],
    [base + 'selection.json', Buffer.from(JSON.stringify({schema: 1, pairs}, null, 2) + '\n')],
  ]) };
}
