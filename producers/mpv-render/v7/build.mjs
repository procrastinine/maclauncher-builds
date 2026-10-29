import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {checkSources} from './package.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'../../..'),recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json')));
export function build({config,check=false}){
 const result=checkSources();
 if(check)return result;
 const source=path.join(root,recipe.source.path);
 if(fs.realpathSync(path.join(import.meta.dirname,'maclauncher/src/external/mpv-player'))!==fs.realpathSync(source))throw Error('The render headers must use the declared upstream source.');
 if(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==recipe.source.revision||execFileSync('git',['-C',source,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Initialize the exact clean mpv source checkout.');
 const input=JSON.parse(fs.readFileSync(config));
 if(crypto.createHash('sha256').update(fs.readFileSync(input.library)).digest('hex')!==recipe.libraryInputSha256)throw Error('The original libmpv image differs from its declared input.');
 if(input.source?.commit!==recipe.source.revision||input.source?.artifact?.sha256!==recipe.artifact.sha256)throw Error('The library input does not match the selected source recipe.');
 return require('./maclauncher/scripts/stage-mpv-render.cjs').stage({...input,version:recipe.version,arch:'arm64',minimumMacOS:recipe.minimumMacOS});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{const args=process.argv.slice(2);if(JSON.stringify(args)===JSON.stringify(['--check']))console.log(JSON.stringify(build({check:true})));else if(args.length===2&&args[0]==='--config')console.log(JSON.stringify(build({config:args[1]})));else throw Error('Use --check or --config /absolute/input.json.');}catch(error){console.error(error.message);process.exitCode=1;}}
