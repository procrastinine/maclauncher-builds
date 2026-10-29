const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'producer-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const Build=require('../producers/maclauncher/src/modules/fna/runtime/build'),Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native');
const fixture=temporary;
test("FNA build overlays affect only private inputs and retain default accelerated graphics", t => {
  const root = fixture(t), source = path.join(root, "upstream.cs"), destination = path.join(root, "staged.cs");
  const line = "[assembly: TypeForwardedToAttribute(typeof(Microsoft.Xna.Framework.GamerServices.GamerServicesComponent))]\n";
  fs.writeFileSync(source, line + "// other types\n"); Build.__test.stageAbiSource(source, destination);
  assert.equal(fs.readFileSync(source, "utf8"), line + "// other types\n"); assert.equal(fs.readFileSync(destination, "utf8"), "// other types\n");
  const gl = path.join(root, "lib", "FNA3D", "src", "FNA3D_Driver_OpenGL.c"); fs.mkdirSync(path.dirname(gl), { recursive: true }); fs.writeFileSync(gl, "SDL_GL_SetAttribute(SDL_GL_ACCELERATED_VISUAL, 1);");
  Build.__test.applyOpenGLPolicy(root); assert.match(fs.readFileSync(gl, "utf8"), /MACLAUNCHER_ALLOW_SOFTWARE_OPENGL/); assert.match(fs.readFileSync(gl, "utf8"), /\? 0 : 1/);
  assert.throws(() => Build.__test.applyOpenGLPolicy(root), /no longer matches/);
  assert.equal(Build.__test.runtimeConfig().runtimeOptions.rollForward, "Disable");
});

test("FNA portable tools download only when a local executable is absent", async t => {
  const temporary = fixture(t); let downloads = 0;
  const found = await Build.__test.resolveBuildTool("ninja", { temporary, findBuildTool: () => "/local/ninja", packageArchive: async () => { downloads++; } });
  assert.equal(found, "/local/ninja"); assert.equal(downloads, 0);
  const installed = await Build.__test.resolveBuildTool("ninja", { temporary, findBuildTool: () => { throw Error("Missing"); }, packageArchive: async (_name, root) => {
    downloads++; fs.mkdirSync(root, { recursive: true }); const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12); fs.writeFileSync(path.join(root, "ninja"), bytes);
  } });
  assert.equal(downloads, 1); assert.deepEqual(Native.readMachOArchitectures(installed), ["arm64"]);
});

test("FNA compiler preserves declared shader resource identities and refuses missing or duplicate inputs", t => {
  const root = fixture(t), resource = path.join(root, "Sprite.fxb");
  fs.writeFileSync(resource, Buffer.from([1, 2, 3, 4]));
  const item = '<EmbeddedResource Include="Sprite.fxb"><LogicalName>Stock.Sprite.fxb</LogicalName></EmbeddedResource>';
  const project = path.join(root, "FNA.Core.csproj"); fs.writeFileSync(project, '<Project>' + item + '</Project>');
  const resources = Build.__test.frameworkResources(root), response = path.join(root, "compile.rsp");
  Build.__test.writeCompilerResponse(response, { sources: [], references: [], resources, output: path.join(root, "Framework.dll") });
  assert.match(fs.readFileSync(response, "utf8"), /\/resource:"[^\n]+Sprite\.fxb",Stock\.Sprite\.fxb/);
  fs.writeFileSync(project, '<Project>' + item + item + '</Project>');
  assert.throws(() => Build.__test.frameworkResources(root), /duplicate/);
  fs.writeFileSync(project, '<Project>' + item + '</Project>'); fs.rmSync(resource);
  assert.throws(() => Build.__test.frameworkResources(root), /ENOENT/);
});

