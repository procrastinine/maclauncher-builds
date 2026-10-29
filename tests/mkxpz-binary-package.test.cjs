const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'producer-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
test("the MKXP-Z binary recipe retains the reviewed artifact, source reference and notices without source inputs", () => {
  const { createStagingInput } = require("../producers/maclauncher/src/modules/rgss/runtime/binary-package");
  const pin = require("../producers/maclauncher/src/modules/rgss/runtime/bundled-binary.json");
  const app = path.join(os.tmpdir(), pin.appName), input = createStagingInput(app);
  assert.equal(input.managerId, "mkxpz"); assert.equal(input.version, pin.version);
  assert.equal(input.appRoot, app); assert.equal(input.expectedInputSha256, pin.executableSha256);
  assert.equal(input.executable, path.join(path.dirname(app), pin.executableRelative));
  assert.equal(input.sourceRoot, undefined); assert.equal(input.provenance.verifiedBuild, false);
  assert.equal(input.provenance.sourceKind, "reviewed-binary");
  assert.equal(input.provenance.publisherSourceRevision, pin.upstreamRevision);
  assert.equal(input.notices[0].file, path.join(path.dirname(app), "LICENSE.txt"));
  assert.equal(input.executableMode, 0o755);
  assert.deepEqual(input.payloads.map(item => item.relative), ["LICENSE.txt", "mkxp.json", "scripts", "stdlib"]);
  assert.equal(input.provenance.inputPublisherArtifactTreeSha256, pin.artifactTreeSha256);
  assert.throws(() => createStagingInput(path.join(os.tmpdir(), "other.app")), /Expected/);
  assert.throws(() => createStagingInput(""), /explicit/);
});

