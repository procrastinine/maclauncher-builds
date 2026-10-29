const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'producer-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const Native=require('../producers/maclauncher/src/modules/shared/runtime/local-native'),MachO=require('../producers/maclauncher/src/modules/shared/runtime/macho-load-commands');
test("the RLVM adapter is a universal system-only library with the declared source", () => {
  const file = path.resolve(__dirname,"../producers/vn-adaptations/rlvm/prebuilt/rlvm-adapter.dylib");
  assert.deepEqual(new Set(Native.readMachOArchitectures(file, { allowLibrary: true })), new Set(["arm64", "x86_64"]));
  MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(file), { fileType: 6, installName: "@rpath/rlvm-adapter.dylib", maximumMacOS: "13.0" });
});
