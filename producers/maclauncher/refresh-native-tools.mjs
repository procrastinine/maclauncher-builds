import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),buildsRoot=path.resolve(root,'../..');
const recipe=JSON.parse(fs.readFileSync(path.join(root,'native-tools-source.json'),'utf8'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const relative=value=>typeof value==='string'&&value.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)&&part!=='.'&&part!=='..');

export function refreshNativeTools(sourceRoot,{check=false}={}){
  if(!path.isAbsolute(sourceRoot||''))throw Error('An absolute MacLauncher source directory is required.');
  sourceRoot=fs.realpathSync(sourceRoot);
  if(recipe.schemaVersion!==1||!Array.isArray(recipe.files)||recipe.files.length>16)throw Error('Invalid native tool source recipe.');
  const prepared=recipe.files.map(record=>{
    if(!relative(record.path)||record.destination!==undefined&&!relative(record.destination))throw Error('Invalid native tool source path.');
    if(record.previousSha256!==undefined&&!/^[a-f0-9]{64}$/.test(record.previousSha256))throw Error('Invalid previous native tool identity.');
    const targetRoot=record.destination===undefined?root:buildsRoot;
    const source=path.join(sourceRoot,record.path),target=path.join(targetRoot,record.destination||record.path);
    if(!fs.lstatSync(source).isFile())throw Error('Native tool source must be a regular file.');
    let content=fs.readFileSync(source,'utf8');
    if(hash(content)!==record.sourceSha256)throw Error('Native tool source differs from its declared identity: '+record.path);
    for(const change of record.replacements||[]){
      if(!change.from||content.split(change.from).length!==2)throw Error('Native tool source replacement is not unique: '+record.path);
      content=content.replace(change.from,change.to);
    }
    if(hash(content)!==record.sha256)throw Error('Native tool adaptation differs from its declared identity: '+record.path);
    if(fs.existsSync(target)){
      if(!fs.lstatSync(target).isFile()||!fs.realpathSync(path.dirname(target)).startsWith(targetRoot+path.sep))throw Error('Native tool destination must be a regular producer file.');
      const current=hash(fs.readFileSync(target));
      if(current!==record.sha256&&current!==record.sourceSha256&&current!==record.previousSha256)throw Error('Native tool destination has local changes: '+record.path);
      if(check&&current!==record.sha256)throw Error('Native tool source refresh is required: '+record.path);
    }else if(check)throw Error('Native tool source is missing: '+record.path);
    return {record,target,content,targetRoot};
  });
  const retired=Object.entries(recipe.retired||{}).flatMap(([relativePath,sha256])=>{
    if(!relative(relativePath)||!/^[a-f0-9]{64}$/.test(sha256)||recipe.files.some(record=>record.path===relativePath))throw Error('Invalid retired native tool source.');
    const target=path.join(root,relativePath);
    if(!fs.existsSync(target))return [];
    if(!fs.lstatSync(target).isFile()||!fs.realpathSync(path.dirname(target)).startsWith(root+path.sep))throw Error('Retired native tool destination must be a regular producer file.');
    if(hash(fs.readFileSync(target))!==sha256)throw Error('Retired native tool destination has local changes: '+relativePath);
    if(check)throw Error('Retired native tool source remains: '+relativePath);
    return [target];
  });
  if(!check)for(const {record,target,content,targetRoot}of prepared){
    fs.mkdirSync(path.dirname(target),{recursive:true});
    if(!fs.realpathSync(path.dirname(target)).startsWith(targetRoot+path.sep))throw Error('Native tool destination escaped its producer directory.');
    if(!fs.existsSync(target)||hash(fs.readFileSync(target))!==record.sha256)fs.writeFileSync(target,content);
  }
  if(!check)for(const target of retired)fs.unlinkSync(target);
  return {repository:recipe.repository,files:prepared.length,retired:retired.length,mode:check?'check':'refresh'};
}
if(process.argv[1]&&fs.existsSync(process.argv[1])&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    if(args[0]!=='--source'||!args[1]||args.length>3||args[2]&&args[2]!=='--check')throw Error('Use --source /absolute/MacLauncher [--check].');
    console.log(JSON.stringify(refreshNativeTools(args[1],{check:args[2]==='--check'})));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
