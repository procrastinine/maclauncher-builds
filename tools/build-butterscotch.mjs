import './producer-environment.mjs';
import {appRequire} from './app-source.mjs';
import {addLicense,addLicenses} from '../lib/licenses.mjs';
import {recipeMain} from './build-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Builder=appRequire('src/modules/gamemaker/runtime/butterscotch.js');
const Catalog=require('../producers/package-support/src/modules/gamemaker/runtime/catalog.js');

export async function buildButterscotch({project:id,version,arch,work,output}) {

  const project=resolveProject(id,root),build=buildRecord(project,version),pin=Catalog.BUTTERSCOTCH_BUILDS.find(row=>row.version===Catalog.BUTTERSCOTCH_ARGUMENTS_VERSION);
  if(!pin)throw Error('The registered version has no source recipe.');
  const raw=path.join(work,'compiled'),sourceDir=path.join(root,'producers/package-support/src/external/Butterscotch');
  fs.mkdirSync(work,{recursive:true});
  const manager={core:{catalog:[pin],resolveRegistered:()=>null,normalizeVersion:value=>value,getInstallDir:()=>raw,registerLocal:options=>{fs.writeFileSync(path.join(raw,'runtime.json'),JSON.stringify({version:build.version}));return options;}}};
  const built=await Builder.buildRuntime({userDataDir:work,version:pin.version,sourceDir,architecture:arch,runtimeManager:manager});

  addLicenses(work,'box2d',path.join(sourceDir,'vendor/box2d'));
  addLicense(work,'FMOD Vorbis setup',path.join(sourceDir,'src/fmod/VORBIS_SETUP_LICENSE.txt'));
  addLicense(work,'JetBrains Mono',path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-JetBrainsMono.txt'));
  addLicenses(work,'miniz',path.join(sourceDir,'vendor/miniz'));
  addLicenses(work,'mojoal',path.join(sourceDir,'vendor/mojoal'));
  addLicense(work,"base64",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-base64.txt'));
  addLicense(work,"bzip2 headers",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-bzip2-headers.txt'));
  addLicense(work,"bzip2 1.0.8",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-bzip2.txt'));
  addLicense(work,"MD5",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-md5.txt'));
  addLicense(work,"miniaudio",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-miniaudio.txt'));
  addLicense(work,"miniz",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-miniz.txt'));
  addLicense(work,"miniz deflate",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-miniz-tdef.txt'));
  addLicense(work,"miniz inflate",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-miniz-tinfl.txt'));
  addLicense(work,"MojoAL pitch conversion",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-mojoal-pitch.txt'));
  addLicense(work,"SHA1",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-sha1.txt'));
  addLicense(work,"stb_ds",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-stb-ds.txt'));
  addLicense(work,"stb_image",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-stb-image.txt'));
  addLicense(work,"stb_image_write",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-stb-image-write.txt'));
  addLicense(work,"stb_vorbis",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-stb-vorbis.txt'));
  addLicense(work,"Khronos platform",path.join(root,'producers/package-support/src/modules/gamemaker/runtime/licenses/butterscotch/LICENSE-khrplatform.txt'));
  return sealRuntime({project:id,version:build.version,arch,output,executable:built.runtimePath,sourceRoot:sourceDir,upstreamRevision:pin.upstreamRevision,provenance:{backend:'appkit',renderer:'legacy-opengl',videoBackend:'none',gameArguments:pin.gameArguments}});
}
recipeMain(import.meta,buildButterscotch);
