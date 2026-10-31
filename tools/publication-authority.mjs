import path from 'node:path';
import {requireGithubBuild} from './build-coverage.mjs';
import {readPublisherInput,verifyPublisherRecord,verifyPublisherArchive,assertPublisherSource} from './publisher-files.mjs';
const root=path.resolve(import.meta.dirname,'..');

/** Compiled code needs a signed GitHub build; unchanged supplied files need exact baseline equality. */
export async function requirePublicationAuthority({record,repository,directory=root,archive,sourceRevision}){
 const input=readPublisherInput({project:record.id,directory});
 if(!input)return {kind:'github-build',...requireGithubBuild({record,repository,directory,archive,sourceRevision})};
 const authority=archive?await verifyPublisherArchive({record,archive,directory}):verifyPublisherRecord({record,repository,directory});
 if(!authority)throw Error('Supplied publisher files require a recorded comparison of the actual input and output archives before publication.');
 if(sourceRevision!==undefined)assertPublisherSource({record,directory,sourceRevision});
 return authority;
}

/** Publisher source tags pin packaging inputs; GitHub source tags match the certified build. */
export function assertPublicationSource({authority,record,directory=root,sourceRevision}){
 if(authority?.kind==='supplied-publisher')return assertPublisherSource({record,directory,sourceRevision});
 if(!/^[a-f0-9]{40}$/.test(authority?.sourceRevision||'')||authority.sourceRevision!==sourceRevision)throw Error('Release source commit differs from the signed GitHub build.');
 return sourceRevision;
}
