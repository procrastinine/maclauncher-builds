import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativeStackInput,stackModule} from '../tools/native-stack.mjs';

test('a prepared native prefix retains source API identity and library bytes while expanding only owned compiler metadata',t=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'native-stack-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const root=path.join(work,'sealed'),view=path.join(work,'view');fs.mkdirSync(path.join(root,'include'),{recursive:true});fs.mkdirSync(path.join(root,'lib/pkgconfig'),{recursive:true});
 const binary=Buffer.from([0,1,2,3,4,5]);fs.writeFileSync(path.join(root,'lib/libsample.1.2.3.dylib'),binary);fs.symlinkSync('libsample.1.2.3.dylib',path.join(root,'lib/libsample.dylib'));fs.writeFileSync(path.join(root,'include/sample.h'),'int sample(void);\n');
 const external=path.join(work,'shared.pc');fs.writeFileSync(external,'prefix=NATIVE_STACK_PREFIX\nsdk=NATIVE_STACK_SDK\n');fs.symlinkSync(external,path.join(root,'lib/pkgconfig/sample.pc'));
 const catalog=stackModule('fonts').PIN;
 fs.writeFileSync(path.join(root,'portable-stack.json'),JSON.stringify({schemaVersion:1,kind:'fonts',architecture:'arm64',stack:{version:catalog.version,architecture:'arm64',minimumMacOS:catalog.minimumMacOS,sources:catalog.dependencies}}));
 const input={root,record:{id:'native-sdl2-fonts',version:'any-custom-package-name'},declaration:{aliases:{schema:1,files:{'lib/libsample.dylib':'lib/libsample.1.2.3.dylib'}}}},options={arch:'arm64',work:view,sdk:'/selected/sdk',tools:{cmake:'/declared/cmake',ninja:'/declared/ninja'}};
 const stack=nativeStackInput(input,options);
 assert.equal(stack.version,catalog.version);assert.equal(stack.preparedInput.record.version,'any-custom-package-name');assert.deepEqual(fs.readFileSync(path.join(view,'lib/libsample.dylib')),binary);assert.equal(fs.realpathSync(path.join(view,'lib/libsample.dylib')),fs.realpathSync(path.join(view,'lib/libsample.1.2.3.dylib')));
 assert.equal(fs.readFileSync(path.join(view,'lib/pkgconfig/sample.pc'),'utf8'),'prefix='+view+'\nsdk=/selected/sdk\n');assert.equal(fs.readFileSync(external,'utf8'),'prefix=NATIVE_STACK_PREFIX\nsdk=NATIVE_STACK_SDK\n');assert.equal(fs.lstatSync(path.join(view,'lib/pkgconfig/sample.pc')).isSymbolicLink(),false);
 assert.throws(()=>nativeStackInput(input,{...options,arch:'x64',work:path.join(work,'wrong-cpu')}),/different target CPU/);assert.equal(fs.existsSync(path.join(work,'wrong-cpu')),false);
});

test('shared native stacks need no unrelated source checkout',async()=>{
 const {resolveProject}=await import('../lib/projects.mjs');
 for(const id of ['native-sdl2-fonts','native-sndfile','native-sdl2-mixer','native-ffmpeg'])assert.ok(!(resolveProject(id,undefined,{resolvePins:false}).build.submodules||[]).some(path=>path.startsWith('sources/anyps5')));
});
