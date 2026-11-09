// A row without its own archive digest uses the shared record of its library.
const sharedDependency=id=>require('../../../../../dependencies/'+id+'.json');
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Source = require("./pinned-native-build");
const Fonts = require("./portable-sdl2-fonts");
const Audio = require("./portable-sndfile");
const Prefix = require("./portable-dependency-prefix");
const { throwIfAborted } = require('../../../../../../lib/abort.cjs');
const PIN = Object.freeze({...require("./portable-sdl2-mixer.json"),dependencies:require("./portable-sdl2-mixer.json").dependencies.map(row=>{const pin=row.archiveSha256?undefined:sharedDependency(row.id);return pin?{...row,revision:pin.revision,sourceUrl:pin.repository,archiveUrl:pin.url||pin.repository+'/archive/'+pin.revision+'.tar.gz',archiveSha256:pin.sha256,archiveBytes:pin.bytes}:{...row,sourceUrl:row.repository||row.sourceUrl,archiveUrl:row.archiveUrl?.replaceAll('{revision}',row.revision)};})});
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function adaptMixer(sourceRoot) {
  const file = path.join(sourceRoot, "CMakeLists.txt");
  if (!path.isAbsolute(sourceRoot || "") || !fs.lstatSync(sourceRoot).isDirectory() || !fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(sourceRoot) + path.sep)) throw new Error("SDL2_mixer adapters require a separate contained source directory.");
  const external = path.resolve(__dirname, "../../../external"), root = fs.realpathSync(sourceRoot);
  if (root === external || root.startsWith(external + path.sep)) throw new Error("SDL2_mixer adapters cannot change source checkouts.");
  const original = fs.readFileSync(file), text = original.toString("utf8"), target = "        find_package(FLAC REQUIRED)";
  if (text.indexOf(target) !== text.lastIndexOf(target) || !text.includes(target)) throw new Error("SDL2_mixer source differs from the selected adapter.");
  const adapted = Buffer.from(text.replace(target, "        find_package(Threads REQUIRED)\n" + target)); fs.writeFileSync(file, adapted);
  return { path: "CMakeLists.txt", sourceSha256: digest(original) };
}

function adaptOpusDescriptor(prefix) {
  const pin = Audio.PIN.dependencies.find(row => row.id === "opus"), file = path.join(prefix,"lib/pkgconfig/opus.pc"), original = fs.readFileSync(file), text=original.toString("utf8");
  if (!["0",pin.version].includes(/^Version:\s*([^\r\n]+)$/m.exec(text)?.[1])) throw new Error("Opus metadata differs from the selected source version.");
  const adapted=Buffer.from(text.replace(/^Version:[^\r\n]+/m,`Version: ${pin.version}`)), temporary=file+".new";
  fs.writeFileSync(temporary,adapted,{flag:"wx"});try{fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
  return { path:"lib/pkgconfig/opus.pc", sourceRevision:pin.revision, version:pin.version };
}

function validateFeatures(outputRoot) {
  return {audioFormats:["WAV","AIFF","FLAC","Ogg Vorbis","Ogg Opus","MP3","MIDI"],midi:"macOS AudioToolbox",dynamicCodecLoading:false};
}

async function buildMixer({archives,workRoot,dependencyStacks,architecture=process.arch,pathMappings=[],signal,onProgress,dependencies={}}) {
  throwIfAborted(signal);
  workRoot=Fonts.assertFreshBuildRoot(workRoot,{readOnlyRoots:Object.values(dependencyStacks||{}).map(stack=>stack.prefix)});
  Fonts.validateArchives(archives);Audio.validateArchives(archives);Audio.validateArchives(archives,{catalog:PIN});
  let fonts,audio;
  if(dependencyStacks){
    if(Object.keys(dependencyStacks).length!==2||!dependencyStacks.fonts||!dependencyStacks.audio)throw new Error("SDL2_mixer reuse needs exact font and audio profiles.");
    fonts=dependencyStacks.fonts;audio=dependencyStacks.audio;
  }
  fs.mkdirSync(workRoot,{recursive:true});
  if(!fonts){fonts=await Fonts.buildDependencies({archives,workRoot:path.join(workRoot,"fonts"),architecture,pathMappings,signal,onProgress,dependencies});audio=await Audio.buildDependencies({archives,workRoot:path.join(workRoot,"audio"),architecture,pathMappings,signal,onProgress,dependencies});}
  if(fonts.sdk!==audio.sdk)throw new Error("SDL2_mixer dependencies must use the same macOS SDK.");
  const prefix=path.join(workRoot,"prefix");fs.mkdirSync(prefix);Prefix.linkPrefix(fonts.prefix,prefix);Prefix.linkPrefix(audio.prefix,prefix);
  const descriptor=adaptOpusDescriptor(prefix),sources=[],sourceRoots={},run=dependencies.runBuildCommand||Source.runBuildCommand;
  for(const pin of PIN.dependencies){
    throwIfAborted(signal);const sourceRoot=path.join(workRoot,"source",pin.id);fs.mkdirSync(sourceRoot,{recursive:true});
    await run("/usr/bin/tar",["-xf",archives[pin.id],"--strip-components","1","-C",sourceRoot],{cwd:workRoot,logPath:path.join(workRoot,"extraction.log"),env:Fonts.buildEnvironment(prefix,fonts.sdk),signal});

    const sourceOverlay=pin.id==="sdl2_mixer"?adaptMixer(sourceRoot):undefined;
    const common={sourceRoot,outputRoot:path.join(workRoot,pin.id),prefix,sdk:fonts.sdk,architecture,pathMappings,options:pin.options,signal,dependencies};
    const build=await(pin.buildSystem==="autotools"?Audio.buildAutotools(common):Fonts.buildProject({...common,tools:fonts.tools,onProgress}));
    sourceRoots[pin.id]=sourceRoot;sources.push({...pin,...build,...(sourceOverlay?{sourceOverlay}:{})});
  }
  const features=validateFeatures(workRoot);
  const readRoots=[fonts.prefix,audio.prefix];
  return {version:PIN.version,architecture,minimumMacOS:PIN.minimumMacOS,prefix,readRoots,sdk:fonts.sdk,tools:fonts.tools,sources,sourceRoots,fonts,audio,descriptor,features};
}

module.exports={PIN,adaptMixer,adaptOpusDescriptor,validateFeatures,buildMixer};
