// Public producer validation for explicitly selected native packages.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const B = require('../src/modules/shared/runtime/bundled-native');
const Declaration = require('../../../lib/declaration.cjs');
const SHA = /^[a-f0-9]{64}$/;

function validatePublicMetadata(value) {
  const projected = require('./native-binary-tools.cjs').publicProvenance(value);
  if (!isDeepStrictEqual(value, projected)) throw new Error('Sealed native metadata contains private diagnostic fields. Restage the package before distribution.');
  return value;
}

function validateDeclaration(item) {
  Declaration.validateDeclaration(item);
  return validatePublicMetadata(item);
}
function nativeHostDependencies(dependencies) {
  const rows = dependencies?.nativeHostDependencies ? dependencies.nativeHostDependencies() : [];
  if (!Array.isArray(rows) || rows.length > 128) throw new Error('Invalid native host dependency declarations.');
  for (const row of rows) {
    if (!row || !/^[a-z0-9-]+$/.test(row.id || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.version || '') ||
        !SHA.test(row.sha256 || '') || B.relativeFile(row.file) !== row.file ||
        typeof row.dependency !== 'string' || !row.dependency.startsWith('@loader_path/') ||
        B.relativeFile(row.dependency.slice(13)) !== row.dependency.slice(13) ||
        !/^[a-z0-9-]+$/.test(row.provider?.id || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.provider?.version || '') ||
        B.relativeFile(row.provider?.file) !== row.provider.file || !Array.isArray(row.installNames) ||
        row.installNames.some(value => typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)))
      throw new Error('Invalid native host dependency declaration.');
  }
  return rows;
}
function verifySupplementals({ resourceRoot, arch, maximumMacOS, items, dependencies = {} }) {
  if (!Array.isArray(items)) throw new Error('Native producer verification requires an explicit package list.');
  const selected = items;
  const hostDependencies = nativeHostDependencies(dependencies);
  for (const item of selected) {
    validateDeclaration(item);
    if (!item.launcherArchitectures.includes(arch) || !B.versionAtLeast(maximumMacOS, item.minimumMacOS)) throw new Error('Supplemental native CPU or macOS floor differs from the requested release.');
    const directory = path.join(resourceRoot, item.directoryRelative);
    B.verifyPayload(directory, item);
    const manifest = JSON.parse(B.readRegular(path.join(directory, item.manifestRelative), B.LIMITS.manifestBytes).bytes);
    validatePublicMetadata(manifest);
    if (process.platform === 'darwin') {
      const native = require('./native-binary-tools.cjs');
      const inspect = dependencies.loadCommands || native.loadCommands;
      const links = dependencies.links || native.links, libraryIds = dependencies.libraryIds || native.libraryIds;
      const resolveLink = dependencies.resolveLink || native.resolveLink;
      const verify = dependencies.verifySignature || (file => execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { timeout: 30000, stdio: 'pipe' }));
      const files = new Map(item.files.filter(file => file.architectures).map(file => [fs.realpathSync(path.join(directory, file.path)), file]));
      const commands = new Map(), linked = new Map();
      function closureFloor(full, architecture, seen = new Set()) {
        const key = JSON.stringify([full, architecture]);
        if (seen.has(key)) return '0.0';
        seen.add(key);
        if (!commands.has(key)) commands.set(key, inspect(full, architecture));
        const info = commands.get(key);
        let floor = info.minimumMacOS;
        if (!linked.has(key)) {
          const ids = libraryIds(full, architecture);
          const file = files.get(full);
          linked.set(key, links(full, architecture).filter(link => !ids.includes(link)).map(link => {
            const host = hostDependencies.find(row => row.id === item.id && row.version === item.version &&
              row.file === file.path && row.sha256 === file.sha256 && row.dependency === link);
            if (host) {
              const provider = selected.find(row => row.id === host.provider.id && row.version === host.provider.version);
              const library = provider?.files.find(row => row.path === host.provider.file);
              if (!library?.architectures?.includes(architecture) || library.optionalLoad)
                throw new Error('The native plugin host dependency is missing from its declared CPU closure.');
              // The provider is verified separately against its complete
              // sealed inventory, CPU slices, load closure, floor and signature.
              return null;
            }
            return resolveLink(link, full, full, info.rpaths || [], architecture);
          }).filter(Boolean));
        }
        for (const dependency of linked.get(key)) {
          if (!files.get(dependency)?.architectures.includes(architecture)) throw new Error('Supplemental native dependency is outside its declared CPU closure.');
          const required = closureFloor(dependency, architecture, seen);
          if (B.versionAtLeast(required, floor)) floor = required;
        }
        return floor;
      }
      let observed = '0.0';
      for (const file of item.files.filter(file => file.architectures)) {
        const full = fs.realpathSync(path.join(directory, file.path));
        for (const architecture of file.architectures) {
          const floor = closureFloor(full, architecture);
          if (file.optionalLoad) {
            // Functional availability checks may require a newer OS than the
            // linked code's deployment target. The complete load closure must
            // fit within that requirement, rather than equal it.
            if (!B.versionAtLeast(file.optionalLoad.minimumMacOS, floor)) throw new Error('Optional native provider exceeds its declared macOS requirement.');
          } else if (B.versionAtLeast(floor, observed)) observed = floor;
        }
        verify(full);
      }
      if (item.files.some(file => file.architectures && !file.optionalLoad) &&
          (!B.versionAtLeast(observed, item.minimumMacOS) || !B.versionAtLeast(item.minimumMacOS, observed)))
        throw new Error('Supplemental native floor differs from its real load commands.');
    }
  }
  return selected;
}
module.exports = { validatePublicMetadata, validateDeclaration, nativeHostDependencies, verifySupplementals };
