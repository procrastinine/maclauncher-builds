import fs from 'node:fs';
import path from 'node:path';

/** The upstream commits that fsr4-native-macos records for the sources it carries, in the order
 * of the provider's source rows: the FSR 4 SDK shader headers (third_party/fsr4/README.upstream.md),
 * the FSR 4.1.1 model (third_party/fsr411/import_manifest.json) and the INT8 shader
 * reimplementation (third_party/fsr411/source_manifest.json). */
export function fsr4SourceCommits(source){
 const read=file=>fs.readFileSync(path.join(source,file),'utf8');
 const commits=[
  read('third_party/fsr4/README.upstream.md').match(/\bat commit\s+\*\*`([0-9a-f]{40})`\*\*/)?.[1],
  JSON.parse(read('third_party/fsr411/import_manifest.json')).source?.sdk_commit,
  JSON.parse(read('third_party/fsr411/source_manifest.json')).upstream_commit
 ];
 if(!commits.every(commit=>/^[0-9a-f]{40}$/.test(commit||'')))throw Error('fsr4-native-macos records no exact commit for each source it carries.');
 return commits;
}
