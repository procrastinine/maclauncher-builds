import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {run} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
const root=path.resolve(import.meta.dirname,'..');
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',...options}).trim();
function lockValue(file,key){
 const matches=[...fs.readFileSync(file,'utf8').matchAll(new RegExp('^'+key+'=([^\\r\\n]+)$','gm'))];
 if(matches.length!==1)throw Error('Missing or ambiguous Android input '+key+'.');
 return matches[0][1];
}
function extractZip(archive,output){fs.mkdirSync(output,{recursive:true});run('/usr/bin/unzip',['-q',archive,'-d',output]);}

/** Acquire the pinned Android compiler and original image inputs for one AIM source profile. */
export async function prepareAndroidBuildInputs({source,work,image,cache=path.join(work,'archive-cache')}){
 if(!path.isAbsolute(source||'')||!path.isAbsolute(work||'')||!path.isAbsolute(cache||'')||fs.existsSync(work))throw Error('Android build inputs require an absolute source and a new absolute work directory.');
 const inputs=JSON.parse(fs.readFileSync(path.join(root,'producers/android-inputs/aim.json')));
 const sdk=path.join(work,'sdk');fs.mkdirSync(work,{recursive:true});
 fs.mkdirSync(cache,{recursive:true});
 const ownedCache=fs.realpathSync(cache).startsWith(fs.realpathSync(work)+path.sep);
 const retireArchive=file=>{if(ownedCache&&fs.realpathSync(file).startsWith(fs.realpathSync(work)+path.sep))fs.unlinkSync(file);};
 fs.mkdirSync(path.join(source,'_build'),{recursive:true});
 const ndk=await buildInput(inputs.ndk,cache);extractZip(ndk,path.join(work,'ndk'));
 const ndkRoot=path.join(work,'ndk',inputs.ndk.directory),properties=fs.readFileSync(path.join(ndkRoot,'source.properties'),'utf8');
 if(!new RegExp('^Pkg.Revision\\s*=\\s*'+inputs.ndk.version.replaceAll('.','\\.')+'\\s*$','m').test(properties))throw Error('The downloaded Android NDK has a different version.');
 const ndkTarget=path.join(sdk,'ndk',inputs.ndk.version);fs.mkdirSync(path.dirname(ndkTarget),{recursive:true});fs.renameSync(ndkRoot,ndkTarget);retireArchive(ndk);
 const javaLock=path.join(source,'upstream/java-toolchain.lock');
 const buildTools=await buildInput({url:lockValue(javaLock,'BUILD_TOOLS_URL'),sha256:lockValue(javaLock,'BUILD_TOOLS_SHA256')},cache);
 extractZip(buildTools,path.join(work,'build-tools'));
 const buildToolsTarget=path.join(sdk,'build-tools',lockValue(javaLock,'BUILD_TOOLS_VERSION'));fs.mkdirSync(path.dirname(buildToolsTarget),{recursive:true});
 fs.renameSync(path.join(work,'build-tools',lockValue(javaLock,'BUILD_TOOLS_DIR')),buildToolsTarget);retireArchive(buildTools);
 const archive=await buildInput({...image,bytes:image.size??image.bytes},cache),imageLock=path.join(source,'image/original.lock');
 if(lockValue(imageLock,'SHA256')!==image.sha256)throw Error('The AIM image and selected image profile differ.');
 const destination=path.join(source,lockValue(imageLock,'ARCHIVE'));fs.mkdirSync(path.dirname(destination),{recursive:true});
 // The supplier only reads this verified archive. Share immutable bytes on one volume.
 try{fs.linkSync(archive,destination);}catch(error){if(error.code!=='EXDEV')throw error;fs.copyFileSync(archive,destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);}
 const pythonRoot=path.join(work,'python');
 const pythonEnv={...process.env,UV_CACHE_DIR:path.join(work,'uv-cache'),UV_PYTHON_INSTALL_DIR:pythonRoot,UV_PYTHON_BIN_DIR:path.join(work,'python-bin')};run('uv',['python','install',inputs.pythonVersion],{env:pythonEnv});
 const python=read('uv',['python','find','--managed-python','--system',inputs.pythonVersion],{env:pythonEnv});
 if(!fs.realpathSync(python).startsWith(fs.realpathSync(pythonRoot)+path.sep))throw Error('The selected Python interpreter is outside the declared build input directory.');
 return {sdk,python,archive,cache};
}

const contained=(root,file)=>file.startsWith(root+path.sep);
async function fileSha256(file){const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
/** Validate the existing producer completion identity before retiring owned input links. */
export async function planAndroidImageArchiveRelease({source,work,cache,image,format}){
 if(![source,work,cache].every(value=>path.isAbsolute(value||''))||path.resolve(work)===path.parse(work).root||!(/^[a-f0-9]{64}$/).test(image?.sha256||''))throw Error('Image archive release needs owned absolute build paths and the declared image checksum.');
 const owned=fs.realpathSync(work),sourceRoot=fs.realpathSync(source);
 if(!contained(owned,sourceRoot))throw Error('The Android source is outside the owned build directory.');
 const lock=path.join(sourceRoot,'image/original.lock'),relative=lockValue(lock,'ARCHIVE');
 if(path.isAbsolute(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..')||lockValue(lock,'SHA256')!==image.sha256)throw Error('The original image archive lock differs from its declared input.');
 const disk=fs.realpathSync(path.join(sourceRoot,'_build/android16-image.dmg'));
 const identity=fs.realpathSync(path.join(sourceRoot,'_build/android16-image/root.identity'));
 if(!contained(owned,disk)||!contained(owned,identity)||!fs.statSync(disk).isFile()||!fs.statSync(disk).size||format!=='UDRO'||fs.readFileSync(identity,'utf8').trim()!==image.sha256)throw Error('The completed original image and its pinned identity are required before archive release.');
 const sourceArchive=path.join(sourceRoot,relative),cacheRoot=fs.existsSync(cache)?fs.realpathSync(cache):path.resolve(cache),cacheOwned=contained(owned,cacheRoot);
 const candidates=[sourceArchive,...(cacheOwned?[path.join(cacheRoot,image.sha256)]:[])],remove=[];
 for(const file of candidates){if(!fs.existsSync(file))continue;const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||!contained(owned,fs.realpathSync(file))||await fileSha256(file)!==image.sha256)throw Error('An owned original-image archive differs from its declared checksum.');remove.push({path:file,bytes:stat.size});}
 return {remove,externalCacheRetained:!cacheOwned,image:disk,identity: image.sha256};
}
/** Retire only this build's archive links after the original image graph succeeds. */
export async function releaseAndroidImageArchive(options){
 const disk=path.join(options.source,'_build/android16-image.dmg');
 const info=read('/usr/sbin/diskutil',['image','info',disk]);
 const format=info.split('\n').map(line=>/^\s*Image Format:\s*(\S+)/.exec(line)?.[1]).find(Boolean);
 const plan=await planAndroidImageArchiveRelease({...options,format});
 for(const entry of plan.remove){if(fs.lstatSync(entry.path).isSymbolicLink()||!contained(fs.realpathSync(options.work),fs.realpathSync(entry.path)))throw Error('An image archive left the owned build directory.');fs.unlinkSync(entry.path);}
 return {removed:plan.remove,externalCacheRetained:plan.externalCacheRetained};
}
