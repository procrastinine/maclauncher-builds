import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readProjects,buildRecords,validateVersionBindings} from '../lib/projects.mjs';
import {projectId} from '../lib/project-identity.mjs';

/** One designated package version per ABI line. Commas and whitespace separate pairs. */
export function parseSelection(input){
 if(typeof input==='string'&&input.trim().startsWith('['))input=JSON.parse(input);
 if(typeof input==='string')input=input.trim().split(/[\s,]+/).filter(Boolean).map(pair=>{const split=pair.indexOf('=');if(split<1||split===pair.length-1)throw Error('Each release is a project=version pair: '+pair);return {id:pair.slice(0,split),version:pair.slice(split+1)};});
 if(!Array.isArray(input)||!input.length)throw Error('Select at least one project=version pair.');
 const seen=new Set();return input.map(row=>{const id=projectId(row.id||row.project),version=row.version,key=id+'='+version;if(typeof version!=='string'||!version)throw Error('Each release is a project=version pair: '+id);if(seen.has(key))throw Error('Duplicate release selection: '+key);seen.add(key);return {id,version};});
}

const base=value=>value.replace(/-MCLv[1-9]\d*$/,'').replace(/^MCLv[1-9]\d*-/,'snapshot-');
const clone=value=>structuredClone(value);
const tokens=pointer=>pointer.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'));
function location(value,pointer){let parent=value;const parts=tokens(pointer),key=parts.pop();for(const part of parts){if(!parent||!Object.hasOwn(parent,part))throw Error('Version binding pointer is missing: '+pointer);parent=parent[part];}if(!parent||!Object.hasOwn(parent,key))throw Error('Version binding pointer is missing: '+pointer);return {parent,key};}
function jsonFiles(directory){if(!fs.existsSync(directory))return [];return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?jsonFiles(path.join(directory,entry.name)):entry.isFile()&&entry.name.endsWith('.json')?[path.join(directory,entry.name)]:[]);}

/** Validate every selected identity and binding before changing any registry or recipe file.
 * dryRun performs the same checks without writing registrations or bindings.
 * Binding selectors match identity objects. {version:"$version"} appends a new
 * release copied from the selected source record; other selectors update only
 * the matched object's package version. Direct pointers address a version field.
 */
export function registerSelection({selection,directory=path.resolve(import.meta.dirname,'..'),tags=[],releases=[],dryRun=false}={}){
 if(typeof dryRun!=='boolean')throw Error('Selection dryRun must be a boolean.');
 const requested=parseSelection(selection);
 directory=fs.realpathSync(directory);const manifestFile=path.join(directory,'projects.json'),manifest=JSON.parse(fs.readFileSync(manifestFile)),registry=readProjects(directory,{resolvePins:false});
 const files=new Map(),originals=new Map(),load=file=>{const requested=path.resolve(directory,file),real=fs.realpathSync(requested);if(real!==requested||!real.startsWith(directory+path.sep))throw Error('Version binding must be a contained regular JSON file.');if(!files.has(file)){const text=fs.readFileSync(real,'utf8');originals.set(file,text);files.set(file,JSON.parse(text));}return files.get(file);};
 const registryPaths=manifest.schemaVersion===2?Object.values(manifest.registries):['projects.json'];
 const mutable=new Map();for(const file of registryPaths){const value=load(file);for(const project of Array.isArray(value)?value:value.projects)mutable.set(project.id,project);}
 const published=new Map();
 for(const file of jsonFiles(path.join(directory,'catalogs'))){const value=JSON.parse(fs.readFileSync(file));for(const record of value.packages||[]){const id=record.id||value.projectId;if(!published.has(id))published.set(id,new Set());published.get(id).add(record.version);}}
 for(const release of releases)if(!release.draft){const tag=typeof release==='string'?release:release.tag_name;for(const request of requested)if(typeof tag==='string'&&tag.startsWith(request.id+'/v'+request.version+'/'))throw Error('Release version is already published: '+request.id+'='+request.version);}
 const plans=[],families=new Set(),include=[];
 for(const request of requested){
  const project=registry.projects.find(row=>row.id===request.id);if(!project)throw Error('Unknown build project: '+request.id);
  if(!project.build||project.producer.kind==='prebuilt')throw Error('Only registered builds can be selected: '+request.id);
  if(published.get(request.id)?.has(request.version))throw Error('Release version is already published: '+request.id+'='+request.version);
  const records=buildRecords(project),matched=records.filter(record=>base(record.version)===base(request.version));
  const sources=matched.length?matched:records.filter(record=>base(record.version)===base(records[0].version));
  const family=base(sources[0].version),familyKey=request.id+'='+family;if(families.has(familyKey))throw Error('Select only one new version for an ABI line: '+familyKey);families.add(familyKey);
  const output={...clone(sources[0]),version:request.version,architectures:[]};delete output.notes;
  for(const source of sources){if(source.command!==output.command)throw Error('ABI line has conflicting build recipes.');for(const arch of source.architectures)if(!output.architectures.includes(arch))output.architectures.push(arch);for(const key of ['tools','submodules','rustTargets','rustComponents'])if(source[key])output[key]=[...new Set([...(output[key]||[]),...source[key]])];if(source.runners)output.runners={...output.runners,...source.runners};if(source.cleanupRunner)output.cleanupRunner=true;if(source.recursiveSubmodules)output.recursiveSubmodules=true;}
  for(const arch of output.architectures)include.push({project:request.id,version:request.version,arch});
  plans.push({request,project:mutable.get(request.id),sources,family,output});
 }
 for(const {request,project,sources,family,output} of plans){
  const previous=sources[0].version,records=Array.isArray(project.build)?project.build:[project.build],remaining=records.filter(record=>base(record.version)!==family);
  const next=[output,...remaining];project.build=next.length===1?next[0]:next;
  if(!project.packageProfiles.some(profile=>profile.version===request.version)){const template=project.packageProfiles.find(profile=>profile.version===previous),identity=clone(template);project.packageProfiles.push({...identity,version:request.version,label:template.label.includes(previous)?template.label.replace(previous,request.version):template.label+' '+request.version});}
  validateVersionBindings(project.versionBindings);
  for(const binding of project.versionBindings||[]){const value=load(binding.file),{parent,key}=location(value,binding.pointer);
   if(binding.select){const rows=parent[key];if(!Array.isArray(rows))throw Error('Selected version binding must address an array.');const matches=rows.filter(row=>Object.entries(binding.select).every(([field,expected])=>row?.[field]===(expected==='$version'?previous:expected)));if(matches.length!==1)throw Error('Version binding must select exactly one identity object.');const selected=matches[0];if(binding.select.version==='$version'){if(!rows.some(row=>row.version===request.version))rows.unshift({...clone(selected),version:request.version});}else{if(!sources.some(source=>source.version===selected.version))throw Error('Version binding differs from the selected package identity.');selected.version=request.version;}}
   else{if(typeof parent[key]!=='string'||!sources.some(source=>source.version===parent[key]))throw Error('Version binding differs from the selected package identity: '+binding.file+binding.pointer);parent[key]=request.version;}
  }
 }
 // Validate generated build/profile contracts without resolving source checkouts.
 for(const {project} of plans)buildRecords(project);
 const changed=[...files].map(([file,value])=>({file,text:JSON.stringify(value,null,2)+'\n'})).filter(row=>row.text!==originals.get(row.file));
 const written=[];try{if(!dryRun)for(const row of changed){fs.writeFileSync(path.join(directory,row.file),row.text);written.push(row.file);}}catch(error){for(const file of written)fs.writeFileSync(path.join(directory,file),originals.get(file));throw error;}
 return {selection:requested,include,files:changed.map(row=>row.file)};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--selection','--directory','--tags','--releases'].includes(key)||!args[i+1])throw Error('Use --selection project=version with optional --directory, --tags and --releases JSON files.');options[key.slice(2)]=['--tags','--releases'].includes(key)?JSON.parse(fs.readFileSync(args[i+1])):args[i+1];}console.log(JSON.stringify(registerSelection(options)));}catch(error){console.error(error.message);process.exitCode=1;}}
