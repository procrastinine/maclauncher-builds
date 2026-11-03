import path from 'node:path';
import {intakeNotices,printWarnings,sourceNotices} from '../lib/notices.mjs';
const FILES=Object.freeze(['LICENSE.txt','src/hidapi/LICENSE.txt','src/hidapi/LICENSE-bsd.txt','src/hidapi/LICENSE-orig.txt','src/hidapi/LICENSE-gpl3.txt','src/hidapi/AUTHORS.txt','src/video/yuv2rgb/LICENSE']);
/** Original SDL and bundled-component notices from a declared source tree. */
export function collectSdlNotices({source,output,name='SDL',sourceUrl,includeLibm=false}){
 const candidates=FILES.map(relative=>({file:path.join(source,relative),path:relative,name:name+' '+relative,license:'See original notice',sourceUrl}));
 if(includeLibm)candidates.push(...sourceNotices(path.join(source,'src/libm'),{all:true,name:name+' libm',repository:sourceUrl}));
 const result=intakeNotices(candidates,{output,packageName:name,sourceUrl});printWarnings(result.warnings);
 return {notices:result.notices,provenance:{name,sourceUrl,includeLibm}};
}
