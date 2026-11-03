import fs from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
export function changedReleaseLines(before,after){
 const lines=text=>text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),previous=new Set(lines(before));
 return [...new Set(lines(after))].filter(line=>!previous.has(line));
}
export function main([before,output]){
 if(!/^[a-f0-9]{40}$/.test(before||'')||!output)throw Error('Use changed-releases.mjs <before commit> <output file>.');
 let previous='';if(!/^0+$/.test(before)&&spawnSync('git',['cat-file','-e',before+':releases.txt'],{stdio:'ignore'}).status===0)previous=execFileSync('git',['show',before+':releases.txt'],{encoding:'utf8'});
 const changed=changedReleaseLines(previous,fs.readFileSync('releases.txt','utf8'));
 fs.writeFileSync(output,changed.join('\n')+(changed.length?'\n':''));
 if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'changed='+Boolean(changed.length)+'\n');
 if(!changed.length&&process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'No release lines were added or changed. Nothing started.\n');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2));
