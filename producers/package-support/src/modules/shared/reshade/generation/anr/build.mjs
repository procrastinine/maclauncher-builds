#!/usr/bin/env node
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appPath} from '../../../../../../../../tools/app-source.mjs';
import {addLicense} from '../../../../../../../../lib/licenses.mjs';
const [headersArg,outputArg]=process.argv.slice(2);
if(!headersArg||!outputArg)throw Error('Usage: build.mjs CONVERTER_INCLUDE OUTPUT');
const source=appPath('src/modules/shared/reshade/generation/anr'),pin=JSON.parse(fs.readFileSync(path.join(source,'source.json')));
const headers=path.resolve(headersArg),output=path.resolve(outputArg),build=path.join(output,'build'),payload=path.join(output,'payload');
const run=(file,args)=>execFileSync(file,args,{stdio:'inherit'});
for(const [relative,expected]of Object.entries(pin.converterHeaders.files))if(crypto.createHash('sha256').update(fs.readFileSync(path.join(headers,relative))).digest('hex')!==expected)throw Error('ANR converter headers differ from the declared exact source: '+relative);
// Build orchestration supplies the shared CPU slot and low priority.
const priority=Number(execFileSync('ps',['-o','nice=','-p',String(process.pid)],{encoding:'utf8'}).trim());if(priority!==19)throw Error('ANR native builds require nice 19.');
run('cmake',['-S',path.join(source,'native'),'-B',build,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64','-DCMAKE_INSTALL_PREFIX='+payload,'-DANR_SHARED_INCLUDE='+appPath('src/modules/shared/reshade/native'),'-DANR_TEMPORAL_INCLUDE='+appPath('src/modules/shared/reshade/temporal'),'-DANR_CONVERTER_INCLUDE='+headers]);
run('cmake',['--build',build,'-j6']);run('cmake',['--install',build]);
for(const name of ['libmaclauncher-anr-generation.dylib','anr-convert-dxil','anr-verify'])run('codesign',['--force','--sign','-',path.join(payload,name)]);
fs.writeFileSync(path.join(payload,'provider.json'),JSON.stringify({method:'anr',providerABI:1,complete:true,preparation:1,architectures:['arm64','x86_64'],minimumMacOS:pin.minimumMacOS,source:{repository:pin.repository,commit:pin.commit},converterHeaders:pin.converterHeaders,userSideAssets:true},null,2)+'\n');
for(const name of ['NOTICE.md','LICENSE.txt'])addLicense(payload,'ANR Metal provider',path.join(source,name),'anr-'+name);

addLicense(payload,'Apple Metal Shader Converter headers',path.join(headers,'metal_irconverter/LICENSE.txt'),'apple-metal-converter-headers');
