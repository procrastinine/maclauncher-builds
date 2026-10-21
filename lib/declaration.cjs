const B=require('./bundled-native.cjs');const SHA=/^[a-f0-9]{64}$/,FLOOR=/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/;
function validatePublicMetadata(value){
 if(/(?:\/Users\/|\/home\/|file:\/\/|(?:password|accessToken|refreshToken|logPath|evidenceSource)"\s*:)/i.test(JSON.stringify(value)))throw Error('Package metadata contains private paths or fields.');return value;
}
function validateSourceArtifact(value){
 if(Object.keys(value).some(k=>!['managerId','version','directoryRelative','sha256','bytes'].includes(k))||!SHA.test(value.sha256||'')||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>B.LIMITS.fileBytes||value.directoryRelative!==value.managerId+'/'+value.version+'-source.tar.gz')throw Error('Invalid corresponding-source identity.');return validatePublicMetadata(value);
}
function validateDeclaration(item) {
  const keys = ['id', 'version', 'arch', 'launcherArchitectures', 'minimumMacOS', 'sourceRelative', 'sourceSha256', 'sourceArtifact', 'directoryRelative', 'manifestRelative', 'manifestSha256', 'files', 'notices', 'redistribution'];
  if (!item || Object.keys(item).some(key => !keys.includes(key)) || !/^[a-z0-9-]+$/.test(item.id || '') ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.version || '') || !['arm64', 'x64', 'universal'].includes(item.arch) ||
    !FLOOR.test(item.minimumMacOS || '') || !SHA.test(item.sourceSha256 || '') || !SHA.test(item.manifestSha256 || '') ||
    !Array.isArray(item.launcherArchitectures) || !item.launcherArchitectures.length || new Set(item.launcherArchitectures).size !== item.launcherArchitectures.length ||
    item.launcherArchitectures.some(arch => !['arm64', 'x64'].includes(arch)) ||
    item.directoryRelative !== `${item.id}/${item.version}/${item.arch}` || !Array.isArray(item.files) || !item.files.length || item.files.length > B.LIMITS.files ||
      !Array.isArray(item.notices) || !item.notices.length ||
      item.redistribution !== undefined && !['bundle', 'local-only'].includes(item.redistribution)) throw new Error('Invalid supplemental native declaration.');
  const names = new Set(); let bytes = 0;
  for (const file of item.files) {
    if (!file || Object.keys(file).some(key => !['path', 'size', 'mode', 'sha256', 'architectures', 'executionArchitecture', 'optionalLoad'].includes(key)) ||
      B.relativeFile(file.path) !== file.path || names.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > B.LIMITS.fileBytes ||
      ![0o644, 0o755].includes(file.mode) || !SHA.test(file.sha256 || '')) throw new Error('Invalid sealed supplemental native file.');
    if (file.architectures && (!Array.isArray(file.architectures) || !file.architectures.length || new Set(file.architectures).size !== file.architectures.length ||
      file.architectures.some(arch => !['arm64', 'x86_64'].includes(arch)))) throw new Error('Invalid supplemental native architectures.');
    if (Object.hasOwn(file, 'optionalLoad')) {
      const optional = file.optionalLoad;
      if (!optional || typeof optional !== 'object' || Array.isArray(optional) || Object.keys(optional).some(key => !['architectures', 'minimumMacOS'].includes(key)) ||
        !file.architectures || Object.hasOwn(file, 'executionArchitecture') || !FLOOR.test(optional.minimumMacOS || '') ||
        !B.versionAtLeast(optional.minimumMacOS, item.minimumMacOS) || !Array.isArray(optional.architectures) || !optional.architectures.length ||
        new Set(optional.architectures).size !== optional.architectures.length || optional.architectures.some(arch => !['arm64', 'x86_64'].includes(arch) || !file.architectures.includes(arch)))
        throw new Error('Optional native loading requires actual CPU slices and an explicit compatible macOS floor.');
    }
    // An explicitly Intel child can run under Rosetta in an ARM launcher. This
    // does not change the library's actual slices or make it loadable in an ARM
    // process; the module must select the Intel host and request Rosetta.
    if (Object.hasOwn(file, 'executionArchitecture')) {
      if (file.executionArchitecture !== 'x86_64' || !file.architectures?.includes('x86_64')) {
        throw new Error('Supplemental execution architecture requires a genuine Intel native file.');
      }
    } else if (!file.optionalLoad && file.architectures && item.launcherArchitectures.some(arch =>
      !file.architectures.includes(arch === 'x64' ? 'x86_64' : arch))) {
      throw new Error('Supplemental native architecture does not cover its launcher CPUs.');
    }
    names.add(file.path); bytes += file.size;
  }
  if (item.sourceArtifact !== undefined) {
    const source = validateSourceArtifact({ managerId: item.id, version: item.version, ...item.sourceArtifact });
    if (source.managerId !== item.id || source.version !== item.version) throw new Error('Supplemental corresponding source must match its package identity.');
  }
  if (bytes > B.LIMITS.bytes || (item.files.some(file => file.optionalLoad) && !item.files.some(file => file.architectures && !file.optionalLoad)) ||
    (!item.sourceArtifact && item.sourceRelative === undefined) ||
    item.sourceRelative !== undefined && !item.files.some(file => file.path === item.sourceRelative && file.sha256 === item.sourceSha256) ||
    !item.files.some(file => file.path === item.manifestRelative && file.sha256 === item.manifestSha256)) throw new Error('Supplemental native source, manifest or dependency inventory is incomplete.');
  for (const notice of item.notices) {
    if (!notice || Object.keys(notice).some(key => !['name', 'license', 'path', 'sourceUrl'].includes(key)) ||
      typeof notice.name !== 'string' || !notice.name.trim() || typeof notice.license !== 'string' || !notice.license.trim() || !names.has(notice.path)) throw new Error('Supplemental native license notice is missing.');
    if (notice.sourceUrl && !/^https:\/\//.test(notice.sourceUrl)) throw new Error('Supplemental source links must use HTTPS.');
  }
  validatePublicMetadata(item);
  return item;
}

module.exports={validateDeclaration};
