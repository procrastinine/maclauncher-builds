/** Standard GitHub-hosted images supported by Runtime recipes. */
export const HOSTED_RUNNERS=Object.freeze({
 'xcode-27':Object.freeze({os:'macos',cpu:'arm64',xcodeVersion:'27.0',sdkVersion:'27.0',developerDirectory:'/Applications/Xcode_27.0.app/Contents/Developer'}),
 'macos-26-intel':Object.freeze({os:'macos',cpu:'x64',xcodeVersion:'26.6',sdkVersion:'26.5',developerDirectory:'/Applications/Xcode_26.6.app/Contents/Developer'}),
 'ubuntu-24.04':Object.freeze({os:'linux',cpu:'x64'}),
 'ubuntu-24.04-arm':Object.freeze({os:'linux',cpu:'arm64'})
});
export function hostedRunner(label){
 if(!Object.hasOwn(HOSTED_RUNNERS,label))throw Error('Select a supported standard GitHub-hosted runner: '+label);
 return HOSTED_RUNNERS[label];
}
