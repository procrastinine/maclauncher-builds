const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const Prefix=require("../producers/maclauncher/src/modules/shared/runtime/portable-dependency-prefix"),Mixer=require("../producers/maclauncher/src/modules/shared/runtime/portable-sdl2-mixer");
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"maclauncher-prefix-test-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test("dependency linking preserves original libraries and requires explicit confined read roots",t=>{
  const root=temporary(t),original=path.join(root,"original"),prefix=path.join(root,"prefix"),output=path.join(root,"output"),outside=path.join(root,"outside");for(const p of [original,prefix,output,outside])fs.mkdirSync(path.join(p,"lib"),{recursive:true});
  fs.writeFileSync(path.join(original,"lib/library"),"bytes");fs.symlinkSync(path.join(original,"lib/library"),path.join(prefix,"lib/library"));
  assert.throws(()=>Prefix.linkPrefix(prefix,output),/declared regular files/);
  Prefix.linkPrefix(prefix,output,{readRoots:[original]});assert.deepEqual(fs.readdirSync(path.join(output,"lib")),["library"]);assert.equal(fs.realpathSync(path.join(output,"lib/library")),fs.realpathSync(path.join(original,"lib/library")));assert.equal(fs.readFileSync(path.join(original,"lib/library"),"utf8"),"bytes");
  const second=path.join(root,"second");fs.mkdirSync(second);fs.writeFileSync(path.join(outside,"lib/escape"),"outside");fs.symlinkSync(path.join(outside,"lib/escape"),path.join(prefix,"lib/escape"));assert.throws(()=>Prefix.linkPrefix(prefix,second,{readRoots:[original]}),/declared regular files/);
});
test("Opus descriptor correction replaces a linked descriptor instead of changing its source",t=>{
  const root=temporary(t),original=path.join(root,"opus.pc"),prefix=path.join(root,"prefix");fs.mkdirSync(path.join(prefix,"lib/pkgconfig"),{recursive:true});fs.writeFileSync(original,"Name: opus\nVersion: 0\n");fs.symlinkSync(original,path.join(prefix,"lib/pkgconfig/opus.pc"));Mixer.adaptOpusDescriptor(prefix);assert.equal(fs.readFileSync(original,"utf8"),"Name: opus\nVersion: 0\n");assert.equal(fs.lstatSync(path.join(prefix,"lib/pkgconfig/opus.pc")).isFile(),true);assert.match(fs.readFileSync(path.join(prefix,"lib/pkgconfig/opus.pc"),"utf8"),/Version: 1\.6\.1/);
});
test("cancelled audio builds stop before writes",async t=>{
  const root=temporary(t);fs.mkdirSync(path.join(root,"sdl2_mixer"));const file=path.join(root,"sdl2_mixer/compile_commands.json");fs.writeFileSync(file,JSON.stringify(["MUSIC_MID_NATIVE MUSIC_FLAC_LIBFLAC MUSIC_MP3_MPG123 MUSIC_OPUS MUSIC_OGG"]));assert.equal(Mixer.validateFeatures(root).dynamicCodecLoading,false);const workRoot=path.join(root,"output");await assert.rejects(Mixer.buildMixer({workRoot,signal:AbortSignal.abort()}),{name:"AbortError"});assert.equal(fs.existsSync(workRoot),false);
});
