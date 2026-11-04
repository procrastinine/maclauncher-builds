import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

/** Remove developer debug records from the copied ANGLE delivery only. Verify
 * the completed build bytes before transforming them; final staging inventories
 * the signed result. The supplied Android framework library stays byte-exact. */
export function publishAndroidAngle(payload,products,angle){
  const files=(angle||[]).map(entry=>{
    if(typeof entry.path!=='string'||path.basename(entry.path)!==entry.path||!entry.path.endsWith('.dylib'))
      throw Error('Invalid Android ANGLE product path');
    const name='native/angle/'+entry.path,product=products.find(value=>value.path===name);
    const file=path.join(payload,name),stat=fs.lstatSync(file),bytes=fs.readFileSync(file);
    const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    if(!stat.isFile()||!product||product.sha256!==sha256||entry.sha256!==sha256||entry.size!==bytes.length)
      throw Error('Android ANGLE product changed before publication: '+entry.path);
    return file;
  });
  for(const file of files){
    execFileSync('/usr/bin/strip',['-S',file],{stdio:'pipe',timeout:60000});
    execFileSync('/usr/bin/codesign',['--force','--sign','-',file],{stdio:'pipe',timeout:60000});
  }
}

/** The compiler output is the payload. There is no second list of libraries,
 * data directories or JARs for staging to accidentally omit. */
export function copyAndroidProducts(build,payload,products) {
  if(!Array.isArray(products)||!products.length)throw Error('Android build has no product inventory');
  const byPath=new Map(products.map(product=>[product.path,product]));
  // Upstream resource modules include aliases (for example older font names).
  // Materialize their recorded target bytes in the portable regular-file
  // payload. An alias cannot import a build input or a file outside this closure.
  function targetOf(product,seen=new Set()){
    if(product.link===undefined)return product;
    if(seen.has(product.path))throw Error('Cyclic Android product alias: '+product.path);
    seen.add(product.path);
    if(typeof product.link!=='string'||!product.link||product.link.includes('\\')||path.isAbsolute(product.link))
      throw Error('Nonportable Android product alias: '+product.path);
    const name=path.normalize(path.join(path.dirname(product.path),product.link));
    const target=byPath.get(name);
    if(!target)throw Error('Android product alias target is not a recorded product: '+product.path);
    return targetOf(target,seen);
  }
  for(const product of products){
    const name=product.path;
    if(typeof name!=='string'||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(name))throw Error('Invalid Android product path');
    const target=targetOf(product);
    const input=path.join(build,target.path),output=path.join(payload,name),stat=fs.lstatSync(input);
    if(!stat.isFile())throw Error('Android product target is not a regular file: '+name);
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(input,output,fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(output,stat.mode&0o111?0o755:0o644);
  }
  return products.length;
}
