import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
import {buildNxNative} from '../producers/nxnative/build.mjs';
import {packageNxNative} from '../producers/nxnative/package.mjs';
const root=path.resolve(import.meta.dirname,'..');
export async function buildNxnative({project,arch,output,work}){
 const record=buildRecord(resolveProject(project,root)),native=path.join(work,'native');
 const pin=JSON.parse(fs.readFileSync(path.join(root,'producers/nxnative/source.json'))),sdkPin=JSON.parse(fs.readFileSync(path.join(root,'producers/nxnative/dotnet-sdk.json')));
 if(execFileSync('/usr/bin/xcrun',['--show-sdk-version'],{encoding:'utf8'}).trim()!==pin.tools.macOSSDK||sdkPin.version!==pin.tools.dotnetSDK)throw Error('The selected macOS or .NET SDK differs from the recipe.');
 const sdk=path.join(work,'dotnet-sdk');fs.mkdirSync(sdk,{recursive:true});
 const archive=await buildInput(sdkPin,path.join(work,'downloads'));execFileSync('/usr/bin/tar',['-xzf',archive,'-C',sdk]);
 const environment={...process.env,PATH:sdk+path.delimiter+process.env.PATH,DOTNET_ROOT:sdk,DOTNET_CLI_HOME:path.join(work,'sdk-home'),DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',DOTNET_GENERATE_ASPNET_CERTIFICATE:'false',DOTNET_ADD_GLOBAL_TOOLS_TO_PATH:'false',DOTNET_NOLOGO:'1',DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE:'true'};
 if(execFileSync(path.join(sdk,'dotnet'),['--version'],{env:environment,encoding:'utf8'}).trim()!==sdkPin.version)throw Error('The downloaded .NET SDK has a different version.');
 const previous={...process.env};Object.assign(process.env,environment);
 try{await buildNxNative({work:path.join(work,'build'),output:native,jobs:4,version:record.version});}
 finally{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
 return packageNxNative({input:native,outputDirectory:path.join(work,'package'),buildOutput:output});
}
recipeMain(import.meta,buildNxnative);
