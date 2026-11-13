import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareBuild} from '../tools/build-runtime.mjs';

// The source initializer reads a checkout's symlink targets with one `cat-file --batch`, passing the
// object names on standard input; a runner that drops it answers none of them.
test('the build preparation gives the source initializer a Git runner that passes standard input',()=>{
 const root=path.resolve(import.meta.dirname,'..');
 let run;
 const stop=Error('initializer reached');
 assert.throws(()=>prepareBuild({project:'vulkan-kosmickrisp-gles32',arch:'arm64',install:false,verifyHost:false,initialize:options=>{run=options.run;throw stop;}}),error=>error===stop);
 const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 assert.match(run(['cat-file','--batch-check'],root,head+'\n'),new RegExp('^'+head+' commit '));
});
