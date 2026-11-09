export function stageStreamlineSnapshots({name,metadata}){
  if(metadata.resourceSnapshotAPI===undefined)return null;
  return {pin:` ${metadata.source.revision} third_party/${name}-snapshot`};
}
