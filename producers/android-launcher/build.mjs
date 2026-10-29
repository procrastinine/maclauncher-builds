import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const options={stdio:'inherit',timeout:120000};
const definitions={
 arguments:{sources:['arguments/java/com/maclauncher/android/arguments/ArgumentsAgent.java','arguments/java/com/maclauncher/android/arguments/ArgumentsBridge.java'],
  level:17,date:'2026-10-21T00:00:00Z',output:'resources/launch-arguments.jar',premain:'com.maclauncher.android.arguments.ArgumentsAgent'},
 privacy:{sources:['PrivacyAgent.java','PrivacyBridge.java','AuthBridge.java','JsonRpc.java','IconPreparation.java','AccountControl.java','Capabilities.java'].map(name=>'providers/macapk/java/'+name),
  level:17,date:'2026-10-19T00:00:00Z',output:'providers/macapk/resources/privacy.jar',premain:'com.maclauncher.android.macapk.PrivacyAgent'},
 'text-input':{sources:['text-input/java/maclauncher/android/framework/HostTextInput.java'],
  level:21,date:'2026-10-21T00:00:00Z',output:'resources/text-input.jar',license:'text-input.LICENSE',metadata:'resources/text-input.json'},
 'account-control':{sources:['store/java/maclauncher/android/AccountControl.java','store/java/maclauncher/android/framework/HostAccountAccess.java'],
  level:21,date:'2026-10-21T00:00:00Z',output:'store/resources/account-control.jar',license:'account-control.LICENSE',metadata:'store/resources/account-control.json'}
};
function regular(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Build inputs must be regular files.');return fs.readFileSync(file);}
function directory(value,label){if(!path.isAbsolute(value||''))throw Error(label+' requires an absolute directory.');const actual=fs.realpathSync(value);if(!fs.statSync(actual).isDirectory())throw Error(label+' requires a directory.');return actual;}
function contains(parent,child){const relative=path.relative(parent,child);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}

/** Compile the owned JARs against an explicitly selected JDK and Android API. */
export function build({jdk,runtime,output,only=Object.keys(definitions)}){
 if(!Array.isArray(only)||!only.length||new Set(only).size!==only.length||only.some(name=>!Object.hasOwn(definitions,name)))throw Error('Select arguments, privacy, text-input or account-control.');
 jdk=directory(jdk,'JDK');runtime=directory(runtime,'Android runtime');
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Choose a new absolute output directory.');
 output=path.join(fs.realpathSync(path.dirname(path.resolve(output))),path.basename(output));
 if([root,jdk,runtime].some(input=>contains(input,output)||contains(output,input)))throw Error('JAR output must be separate from its inputs.');
 for(const tool of ['javac','jar'])regular(path.join(jdk,'bin',tool));
 const sourceIdentity=JSON.parse(regular(path.join(root,'source.json')));
 if(!Array.isArray(sourceIdentity.sourceFiles)||!sourceIdentity.sourceFiles.length)throw Error('The owned Android integration source inventory is missing.');
 for(const input of sourceIdentity.sourceFiles){
  if(!input.path.startsWith('source/')||input.path.split('/').some(part=>part==='..'||part==='.')||digest(regular(path.join(root,input.path)))!==input.sha256)throw Error('Owned Android integration source differs from its source inventory.');
 }
 const classpath=['android-host.jar','android-framework.jar'].map(name=>path.join(runtime,name));
 if(only.some(name=>definitions[name].level===21))classpath.forEach(regular);
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-launcher-build-')),result=[];
 fs.mkdirSync(output,{recursive:true});
 try{
  for(const name of only){
   const definition=definitions[name],classes=path.join(temporary,name);fs.mkdirSync(classes);
   const sources=definition.sources.map(file=>path.join(root,'source',file));sources.forEach(regular);
   const flags=definition.level===17?['-source','17','-target','17','--add-exports','java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED']:
    ['--release','21','-classpath',classpath.join(path.delimiter)];
   execFileSync(path.join(jdk,'bin/javac'),[...flags,'-proc:none','-encoding','UTF-8','-d',classes,...sources],options);
   if(definition.license){
    const metadata=path.join(classes,'META-INF');fs.mkdirSync(metadata);fs.writeFileSync(path.join(metadata,'LICENSE'),regular(path.join(root,'supplied',definition.license)));
   }
   const target=path.join(output,definition.output);fs.mkdirSync(path.dirname(target),{recursive:true});
   const jar=['--create','--file',target];
   if(definition.premain){const manifest=path.join(temporary,name+'.MF');fs.writeFileSync(manifest,'Manifest-Version: 1.0\nPremain-Class: '+definition.premain+'\n\n');jar.push('--manifest',manifest);}
   jar.push('--date='+definition.date,'-C',classes,'.');execFileSync(path.join(jdk,'bin/jar'),jar,options);
   const sha256=digest(regular(target));
   if(definition.metadata){
    const metadata={schema:1,sourceSha256:digest(regular(sources[0])),...(sources.length===2?{policySourceSha256:digest(regular(sources[1]))}:{}),sha256};
    fs.writeFileSync(path.join(output,definition.metadata),JSON.stringify(metadata,null,2)+'\n');
   }
   result.push({component:name,path:definition.output,sha256,bytes:fs.statSync(target).size,javaMajor:definition.level});
  }
  fs.copyFileSync(path.join(root,'supplied/LICENSE'),path.join(output,'LICENSE'));
  return result;
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
 finally{fs.rmSync(temporary,{recursive:true,force:true});}
}

export function main(args,fixedOnly){
 const o={};for(let n=0;n<args.length;n+=2){const key=args[n]?.slice(2);if(!args[n]?.startsWith('--')||!['jdk','runtime','output','only'].includes(key)||!args[n+1]||Object.hasOwn(o,key))throw Error('Use --jdk, --runtime, --output and optional --only.');o[key]=key==='only'?args[n+1].split(','):args[n+1];}
 if(fixedOnly&&o.only)throw Error('This entry builds one selected component.');
 return build({...o,...(fixedOnly?{only:[fixedOnly]}:{})});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
