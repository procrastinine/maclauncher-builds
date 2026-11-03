import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sdkCompressionPkgConfig} from '../tools/build-mpv.mjs';

test('mpv supplies SDK compression metadata for pkgconf private cflags requirements',t=>{
 const command=['pkgconf','pkg-config'].find(name=>spawnSync(name,['--version']).status===0);
 if(!command)return t.skip('pkg-config is unavailable');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpv-sdk-pc-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sdk=path.join(root,'SDK'),packages=path.join(root,'pkgconfig'),empty=path.join(root,'empty');
 for(const directory of [path.join(sdk,'usr/include'),path.join(sdk,'usr/lib'),packages,empty])fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(sdk,'usr/include/zlib.h'),'#define ZLIB_VERSION "1.2.12"\n');
 fs.writeFileSync(path.join(sdk,'usr/include/bzlib.h'),'/* bzip2/libbzip2 version 1.0.8 */\n');
 for(const name of ['z','bz2'])fs.writeFileSync(path.join(sdk,'usr/lib','lib'+name+'.tbd'),'SDK library declaration');
 for(const [name,requires] of [['libass','freetype2, libpng'],['freetype2','zlib, bzip2'],['libpng','zlib']]){
  fs.writeFileSync(path.join(packages,name+'.pc'),'Name: '+name+'\nDescription: Private dependency fixture\nVersion: 1.0\nRequires.private: '+requires+'\nLibs: -l'+name+'\nCflags: -I'+root+'/'+name+'\n');
 }
 const env={...process.env,PKG_CONFIG_LIBDIR:empty,PKG_CONFIG_PATH:packages};
 const before=spawnSync(command,['--cflags','libass'],{env,encoding:'utf8'});
 assert.notEqual(before.status,0);assert.match(before.stderr,/zlib|bzip2/);
 const owned=sdkCompressionPkgConfig({sdk,directory:path.join(root,'sdk-pkgconfig')});env.PKG_CONFIG_PATH=owned+path.delimiter+packages;
 const after=spawnSync(command,['--cflags','libass'],{env,encoding:'utf8'});
 assert.equal(after.status,0,after.stderr);assert.ok(after.stdout.includes('-I'+root+'/freetype2'));
 const libraries=spawnSync(command,['--static','--libs','libass'],{env,encoding:'utf8'});
 assert.equal(libraries.status,0,libraries.stderr);assert.match(libraries.stdout,/-lz\b/);assert.match(libraries.stdout,/-lbz2\b/);
 for(const [name,version] of [['zlib','1.2.12'],['bzip2','1.0.8']])assert.equal(spawnSync(command,['--modversion',name],{env,encoding:'utf8'}).stdout.trim(),version);
});
