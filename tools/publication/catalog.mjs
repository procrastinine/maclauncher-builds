import fs from 'node:fs';
import path from 'node:path';
/** Publish catalog metadata; it is not part of a package build. */
export async function writeCatalog(o,project,directory){
  if(!o.packages?.length||!o.output)throw Error('catalog requires --package records and --output.');
  if(path.basename(o.output)!==o.project+'.json')throw Error('Catalog filename must be '+o.project+'.json');
  const previous=o.previous?JSON.parse(fs.readFileSync(o.previous)):undefined;
  const records=o.packages.map(file=>JSON.parse(fs.readFileSync(file)));
  const {requirePublicationAuthority}=await import('../publication-authority.mjs');
  for(const record of records)await requirePublicationAuthority({record,repository:project.releaseRepository,directory:directory});
  if(fs.existsSync(o.output)&&(!o.previous||path.resolve(o.previous)!==path.resolve(o.output)))throw Error('Use --previous to retain existing published versions.');
  const {writePublicationCatalog}=await import('../catalog-publication.mjs');
  return writePublicationCatalog({records,project:o.project,repository:project.releaseRepository,directory:directory,output:o.output,previous});
}
