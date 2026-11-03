import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

/** Every build stamps one fixed time, 1980-01-01 00:00 UTC, so output never depends on when or at which commit it ran. */
export const SOURCE_DATE_EPOCH = 315532800;

export function reproducibleEnvironment(environment = process.env) {
 return {...environment, SOURCE_DATE_EPOCH:String(SOURCE_DATE_EPOCH), ZERO_AR_DATE:'1', TZ:'UTC', LC_ALL:'C', PYTHONHASHSEED:'0'};
}

/** Version of the SDK selected for compilation, including an explicit SDK root. */
export function macosSDKVersion(environment = process.env, {read = (command,args) => execFileSync(command,args,{env:environment,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()} = {}) {
 return environment.SDKROOT && path.isAbsolute(environment.SDKROOT)
  ? JSON.parse(fs.readFileSync(path.join(environment.SDKROOT, 'SDKSettings.json'), 'utf8')).Version
  : read('/usr/bin/xcrun',['--sdk',environment.SDKROOT || 'macosx','--show-sdk-version']);
}

/** Tool versions are observations; no host paths or wall-clock values are retained. */
export function buildToolchain(environment = process.env) {
 const read = (command,args) => {try{return execFileSync(command,args,{env:environment,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return undefined;}};
 const clang = read('/usr/bin/xcrun',['clang','--version'])?.split('\n')[0];
 const xcode = read('/usr/bin/xcodebuild',['-version']);
 let sdk;
 try {
  sdk = macosSDKVersion(environment, {read});
 } catch { /* Unavailable toolchain observations stay absent. */ }
 return {node:process.versions.node,zlib:process.versions.zlib,...(clang?{clang}:{}),...(xcode?{xcode}:{}),...(sdk?{macosSDK:sdk}:{})};
}
