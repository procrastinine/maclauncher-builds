import {gitlink,sourceRevision} from '../../../lib/pins.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {checkSources} from './package.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'../../..'),recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json')));
recipe.source.revision=gitlink(recipe.source.path);
export function build({config,check=false}){
 const result=checkSources();
 if(check)return result;
 const source=path.join(root,recipe.source.path);
 if(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sourceRevision(recipe.source)||execFileSync('git',['-C',source,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Initialize the exact clean mpv source checkout.');
 const input=JSON.parse(fs.readFileSync(config));
 if(input.source?.commit!==sourceRevision(recipe.source))throw Error('The library input does not match the selected source recipe.');
 return require('./scripts/stage-mpv-render.cjs').stage({...input,version:recipe.version,arch:'arm64',minimumMacOS:recipe.minimumMacOS});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{const args=process.argv.slice(2);if(JSON.stringify(args)===JSON.stringify(['--check']))console.log(JSON.stringify(build({check:true})));else if(args.length===2&&args[0]==='--config')console.log(JSON.stringify(build({config:args[1]})));else throw Error('Use --check or --config /absolute/input.json.');}catch(error){console.error(error.message);process.exitCode=1;}}
