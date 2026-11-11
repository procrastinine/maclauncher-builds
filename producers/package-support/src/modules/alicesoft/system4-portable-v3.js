// A row without its own archive digest uses the shared record of its library.
const sharedDependency=id=>require('../../../../dependencies/'+id+'.json');
const {upstreamRevision} = require("../../../../../lib/projects.mjs");
const fs = require("node:fs");
const path = require("node:path");
const Source = require("../shared/runtime/pinned-native-build");
const Native = require('../../../../../lib/package-format.cjs');
const Fonts = require("../shared/runtime/portable-sdl2-fonts");
const Audio = require("../shared/runtime/portable-sndfile");
const Movie = require("../shared/runtime/portable-ffmpeg");
const Prefix = require("../shared/runtime/portable-dependency-prefix");
const Overlay = require("./system4-portable-overlay-v3");
const { throwIfAborted } = require('../../../../../lib/abort.cjs');
// Portable libffi uses its configured release archive; the Git snapshot does not contain configure.
const PIN = Object.freeze({...require("./system4-portable.json"),dependencies:require("./system4-portable.json").dependencies.map(row=>{if(row.id==='webp')row={...require('./system35-portable.json').dependencies.find(pin=>pin.id==='webp'),...row};const pin=row.archiveSha256?undefined:sharedDependency(row.id==='libffi'?'libffiPortable':row.id);return pin?{...row,revision:pin.revision,sourceUrl:pin.repository,archiveUrl:pin.url||pin.repository+'/archive/'+pin.revision+'.tar.gz',archiveSha256:pin.sha256,archiveBytes:pin.bytes}:{...row,sourceUrl:row.repository||row.sourceUrl,archiveUrl:row.archiveUrl?.replaceAll('{revision}',row.revision)};})});
const VERSION = "MCLv9";
const REVISION = upstreamRevision("xsystem4", "xsystem4");
const SOURCE_SHA256 = "4573e25bd5958bb6b7d8b28b6e1c0036af5c752e304d30c8afa270c7818ba0c0";
const sourcePath = path.resolve(__dirname, "../../external/xsystem4");
function nativeFile({ prefix, sdk, pathMappings, tools, architecture = process.arch }) {
  for(const value of [prefix,sdk,...Object.values(tools)]) if(!path.isAbsolute(value||"")||/[\r\n\0]/.test(value))throw new Error("Portable Meson build paths must be absolute.");
  const flags=Audio.compilerFlags(sdk,pathMappings,architecture).split(" ");
  const quote=value=>"'"+value.replaceAll("\\","\\\\").replaceAll("'","\\'")+"'";
  const list=values=>"["+values.map(quote).join(", ")+"]";
  const text = "[binaries]\n"+Object.entries({c:"/usr/bin/clang",cpp:"/usr/bin/clang++",objc:"/usr/bin/clang",ar:"/usr/bin/ar",strip:"/usr/bin/strip",'pkg-config':tools.pkgconfig,bison:tools.bison,flex:tools.flex}).map(([key,value])=>key+" = "+quote(value)).join("\n")+
    "\n[built-in options]\nc_args = "+list(flags)+"\nc_link_args = "+list(["-arch",architecture==="x64"?"x86_64":"arm64","-mmacosx-version-min=13.0","-isysroot",sdk,"-Wl,-headerpad_max_install_names","-Wl,-rpath,"+path.join(prefix,"lib")])+"\ncmake_prefix_path = []\npkg_config_path = []\n";
  return text.replace(/^c_args = (.*)$/m, (line, flags) => line + "\nobjc_args = " + flags)
    .replace(/^c_link_args = (.*)$/m, (line, flags) => line + "\nobjc_link_args = " + flags);
}

function validateFeatures(outputRoot) {
  const commands=JSON.parse(fs.readFileSync(path.join(outputRoot,"compile_commands.json"),"utf8"));
  if(!Array.isArray(commands)||commands.length>2000)throw new Error("Invalid xsystem4 compilation inventory.");
  const files=commands.map(row=>path.basename(row.file));
  for(const name of ["debug.c","debugger_dap.c","movie_ffmpeg.c"])if(!files.includes(name))throw new Error("xsystem4 did not compile its selected debugger/movie profile.");
  if(files.some(name=>["movie_plmpeg.c","debugger_scm.c"].includes(name))||commands.some(row=>/HAVE_SCHEME|HAVE_READLINE|(?:-I|-L)\s?\/(?:opt\/homebrew|usr\/local)/.test(row.command||"")))throw new Error("xsystem4 enabled an unselected dependency.");
  return {debugger:true,debugAdapter:true,schemeDebugger:false,readline:false,appleOpenGL:"3.2 core",glsl:"150",webp:true,jpeg:true,
    audioFormats:Audio.PIN.audioFormats,movieVersion:Movie.PIN.source.version,movieDecoders:Movie.PIN.decoders,movieDemuxers:Movie.PIN.demuxers,movieNetwork:false,movieExternalCodecs:false};
}

function applyIdentity(sourceRoot) {
  const video=path.join(sourceRoot,"src/video.c"),text=fs.readFileSync(video,"utf8"),anchor="\tSDL_SetWindowTitle(sdl.window, title);";
  if(text.split(anchor).length!==2)throw new Error("Pinned xsystem4 window identity boundary changed.");
  fs.writeFileSync(video,text.replace(anchor,'\tconst char *display_name = SDL_getenv("MACLAUNCHER_GAME_NAME");\n\tSDL_SetWindowTitle(sdl.window, display_name && *display_name ? display_name : title);'));
  const file=path.join(sourceRoot,"src/meson.build"),meson=fs.readFileSync(file,"utf8"),entry="executable('xsystem4', xsystem4,";
  if(meson.split(entry).length!==2)throw new Error("Pinned xsystem4 native target changed.");
  fs.copyFileSync(path.join(__dirname,"../shared/runtime/application-identity.m"),path.join(sourceRoot,"src/maclauncher-application-identity.m"));
  fs.writeFileSync(file,meson.replace(entry,"if host_machine.system() == 'darwin'\n    add_languages('objc', native : false)\n    xsystem4 += 'maclauncher-application-identity.m'\n    xsystem4_deps += dependency('appleframeworks', modules : ['AppKit'])\nendif\n\n"+entry).replace("           c_args : ['-Wno-unused-parameter'],","           c_args : ['-Wno-unused-parameter'],\n           objc_args : ['-fobjc-arc', '-fblocks'],"));
}
async function buildPortableSystem4({ sourceDir=sourcePath,archives,workRoot,dependencyStacks,architecture=process.arch,pathMappings=[],signal,onProgress,dependencies={} }) {
  throwIfAborted(signal);
  if(process.platform!=="darwin"||!["arm64","x64"].includes(architecture))throw new Error("xsystem4 builds require macOS and an arm64 or x64 target.");
  workRoot=Fonts.assertFreshBuildRoot(workRoot,{readOnlyRoots:[sourceDir,...Object.values(dependencyStacks||{}).map(stack=>stack.prefix)]});
  Fonts.validateArchives(archives);Audio.validateArchives(archives);Audio.validateArchives(archives,{catalog:PIN});
  if(!path.isAbsolute(archives?.ffmpeg||""))throw new Error("Portable movies require the FFmpeg source archive.");
  const source=await Source.pinnedFiles(sourceDir,REVISION,{signal});
  const libsys4Revision = require("node:child_process").execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD:subprojects/libsys4"], { encoding: "utf8" }).trim();
  let fonts,audio,movie;
  if(dependencyStacks){
    if(Object.keys(dependencyStacks).length!==3||!dependencyStacks.fonts||!dependencyStacks.audio||!dependencyStacks.movie)throw new Error("Portable dependency reuse needs font, audio and movie profiles.");
    ({fonts,audio,movie}=dependencyStacks);
  }
  fs.mkdirSync(workRoot,{recursive:true});
  if(!fonts){
    fonts=await Fonts.buildDependencies({archives,workRoot:path.join(workRoot,"font-dependencies"),architecture,pathMappings,signal,onProgress,dependencies});
    audio=await Audio.buildDependencies({archives,workRoot:path.join(workRoot,"audio-dependencies"),architecture,pathMappings,signal,onProgress,dependencies});
    movie=await Movie.buildDependencies({archive:archives.ffmpeg,workRoot:path.join(workRoot,"movie-dependencies"),architecture,pathMappings,signal,onProgress,dependencies});
  }
  if(fonts.sdk!==audio.sdk||fonts.sdk!==movie.sdk)throw new Error("Portable dependency profiles must use the same macOS SDK.");
  const prefix=path.join(workRoot,"prefix"),sourceRoots={},sources=[];fs.mkdirSync(prefix);
  Prefix.linkPrefix(fonts.prefix,prefix);Prefix.linkPrefix(audio.prefix,prefix);Prefix.linkPrefix(movie.prefix,prefix);
  const find=dependencies.findBuildTool||Source.findBuildTool;
  const tools={...fonts.tools,meson:find("meson"),pkgconfig:find("pkg-config"),bison:find("bison"),flex:find("flex")};
  const run=dependencies.runBuildCommand||Source.runBuildCommand,env=Fonts.buildEnvironment(prefix,fonts.sdk);
  for(const pin of PIN.dependencies){
    throwIfAborted(signal);const sourceRoot=path.join(workRoot,"source",pin.id);fs.mkdirSync(sourceRoot,{recursive:true});
    await run("/usr/bin/tar",["-xf",archives[pin.id],"--strip-components","1","-C",sourceRoot],{cwd:workRoot,logPath:path.join(workRoot,"extraction.log"),env,signal});

    onProgress?.({phase:"build",project:pin.id});
    const common={sourceRoot:path.join(sourceRoot,pin.sourceSubdirectory||""),outputRoot:path.join(workRoot,pin.id),prefix,sdk:fonts.sdk,architecture,pathMappings,options:pin.options,signal,dependencies};
    const build=await(pin.buildSystem==="autotools"?Audio.buildAutotools(common):Fonts.buildProject({...common,tools,onProgress}));
    sources.push({...pin,...build,sourceRoot});sourceRoots[pin.id]=sourceRoot;
  }
  const sourceRoot=path.join(workRoot,"xsystem4-source");Source.stagePinnedFiles(sourceDir,source.files,sourceRoot);
  const sourceOverlay=Overlay.apply(sourceRoot,{sourceDir,version:VERSION});
  applyIdentity(sourceRoot);
  const buildFile=path.join(workRoot,"native.ini");fs.writeFileSync(buildFile,nativeFile({prefix,sdk:fonts.sdk,architecture,pathMappings,tools}));
  const outputRoot=path.join(workRoot,"xsystem4"),logPath=path.join(workRoot,"xsystem4.log"),startedAt=new Date().toISOString();
  env.GIT_CEILING_DIRECTORIES=workRoot;env.NINJA=tools.ninja;
  const configureOptions=["setup",outputRoot,sourceRoot,"--native-file",buildFile,"--wrap-mode=nodownload","--buildtype=release","--prefix",prefix,
    "-Dopengles=disabled","-Ddebugger=enabled","-Dscheme=disabled","-Dreadline=disabled","-Dffmpeg=enabled"];
  await run(tools.meson,configureOptions,{cwd:workRoot,logPath,env,signal});
  await run(tools.ninja,["-C",outputRoot,"-j2"],{cwd:workRoot,logPath,env,signal});
  await run(tools.meson,["install","-C",outputRoot,"--no-rebuild"],{cwd:workRoot,logPath,env,signal});
  throwIfAborted(signal);const features=validateFeatures(outputRoot);
  const executable=path.join(prefix,"bin/xsystem4");
  return {managerId:"xsystem4",version:VERSION,sourceRevision:REVISION,libsys4Revision,sourceOverlay,
    architecture,minimumMacOS:"13.0",executable,executableSha256:Native.hashFile(executable),resources:path.join(prefix,"share/xsystem4"),features,
    sourceRoot,outputRoot,prefix,sdk:fonts.sdk,tools,configureOptions,startedAt,completedAt:new Date().toISOString(),logPath,
    dependencyClosure:{version:PIN.version,prefix,fonts,audio,movie,sources,sourceRoots}};
}
module.exports={applyIdentity,VERSION,REVISION,SOURCE_SHA256,PIN,sourcePath,nativeFile,validateFeatures,buildPortableSystem4};
