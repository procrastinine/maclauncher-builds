import {gitlink} from '../../../lib/pins.mjs';
/** The exact revision of a source record: its `commit`, its `revision`, or the
 * commit of the Builds gitlink that its `gitlink` path names. */
export function sourceRevision(record){
 const revision=record?.commit||record?.revision||(typeof record?.gitlink==='string'?gitlink(record.gitlink):'');
 if(!/^[a-f0-9]{40}$/.test(revision))throw Error('An exact graphics source revision is required.');
 return revision;
}
