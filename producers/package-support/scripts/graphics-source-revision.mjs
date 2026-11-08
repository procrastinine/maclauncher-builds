import {gitlink} from '../../../lib/pins.mjs';
/** Read an exact app source pin or its Builds gitlink declaration. */
export function sourceRevision(record){
 const revision=record?.commit||gitlink(record?.gitlink);
 if(!/^[a-f0-9]{40}$/.test(revision))throw Error('An exact graphics source revision is required.');
 return revision;
}
