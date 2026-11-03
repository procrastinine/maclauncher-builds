import crypto from 'node:crypto';
/** JSON with sorted keys and no undefined members, so equal reports have equal bytes. */
export function canonicalReport(value){
 if(Array.isArray(value))return '['+value.map(canonicalReport).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonicalReport(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
export const reportDigest=value=>crypto.createHash('sha256').update(canonicalReport(value)).digest('hex');
