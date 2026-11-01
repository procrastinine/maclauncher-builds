import fs from 'node:fs';
import path from 'node:path';

function owner(repository){
 if(typeof repository!=='string')return null;
 const match=/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.exec(repository);
 return match?.[1].toLowerCase()||null;
}
export const sameSourceOwner=(source,distribution)=>!!owner(source)&&owner(source)===owner(distribution);

/** The product's source, separately from the repository holding its recipe.
 * Composite products can identify their own source repository explicitly;
 * otherwise foreign upstream inputs identify a derived package. */
export function ownedPackageSource(project,distribution,directory){
 const producer=project.producer;
 if(producer?.sourceRepository)return sameSourceOwner(producer.sourceRepository,distribution);
 if(producer?.kind==='pinned-source'){
  const recipe=JSON.parse(fs.readFileSync(path.join(directory,producer.recipe)));
  return sameSourceOwner(recipe.repository,distribution);
 }
 return producer?.kind==='maclauncher'&&sameSourceOwner(producer.repository,distribution)&&
  project.upstreams.every(source=>sameSourceOwner(source.repository||source.url,distribution));
}

export function plainSemanticVersion(value){
 return typeof value==='string'&&!/MCL/i.test(value)&&
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value);
}
