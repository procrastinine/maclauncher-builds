const requirements = require('./support/requirements.cjs');
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Overlay = require("../producers/maclauncher/src/modules/mages/native/windows-checkpoint-overlay");
const Session = require("../producers/maclauncher/src/modules/mages/native/windows-checkpoint-session");

const nativeRoot = path.resolve(__dirname, "../producers/maclauncher/src/modules/mages/native");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("checkpoint adapters reject mismatched exports and linked outputs without modifying inputs", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-checkpoint-overlay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, ".git"));
  assert.throws(() => Overlay.applyWindowsCheckpointOverlay(source), /separate source export/);
  fs.rmdirSync(path.join(source, ".git"));
  const original = Buffer.from("source from a different version\n");
  fs.writeFileSync(path.join(source, "CMakeLists.txt"), original);
  assert.throws(() => Overlay.applyWindowsCheckpointOverlay(source), /checksum/);
  assert.deepEqual(fs.readFileSync(path.join(source, "CMakeLists.txt")), original);
  const linked = path.join(root, "linked"); fs.symlinkSync(source, linked);
  assert.throws(() => Overlay.applyWindowsCheckpointOverlay(linked), /separate source export/);
  assert.throws(() => Overlay.applyWindowsCheckpointOverlay(path.resolve(__dirname, "../producers/maclauncher/src/external")), /external checkouts/);
});

test("compiled Windows checkpoint instructions consume LEu16 atomically and preserve legacy type widths",
  requirements({ sourceTree: 'producers/maclauncher/src/external/impacto', appleSiliconMacOS: true }), t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-checkpoint-native-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const vm = path.join(root, "vm"), data = path.join(root, "data"), profile = path.join(root, "profile");
    fs.mkdirSync(vm); fs.mkdirSync(data); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(vm, "vm.h"), `#pragma once
#include <cstdint>
#include <vector>
#include <stdexcept>
namespace Impacto::Vm {
struct Sc3VmThread {
  std::vector<uint8_t> Bytes; uint32_t IpOffset = 0;
  uint8_t* GetIp(size_t length = 1) {
    if (IpOffset > Bytes.size() || length > Bytes.size() - IpOffset)
      throw std::runtime_error("bounded operand read");
    return Bytes.data() + IpOffset;
  }
};
inline bool BlockCurrentScriptThread = false;
}
#define VmInstruction(name) void name(Impacto::Vm::Sc3VmThread* thread, float dt)
`);
    fs.writeFileSync(path.join(vm, "inst_macros.inc"), `#define StartInstruction thread->GetIp(2); thread->IpOffset += 2
#define BlockThread BlockCurrentScriptThread = true
#define PopUint8(name) uint8_t name = *thread->GetIp(); thread->IpOffset += 1
#define PopUint16(name) auto* pointer = thread->GetIp(2); uint16_t name = pointer[0] | (uint16_t(pointer[1]) << 8); thread->IpOffset += 2
`);
    fs.writeFileSync(path.join(vm, "inst_system.h"), `#pragma once
#include "vm.h"
namespace Impacto::Vm { VmInstruction(InstAutoSaveOld); }
`);
    fs.writeFileSync(path.join(profile, "scriptvars.h"), `#pragma once
namespace Impacto::Profile::ScriptVars {
inline constexpr int SF_SAVECAPTURE = 42, SF_SAVEDISABLE = 43, SF_AUTOSAVEENABLE = 44, SW_AUTOSAVERESTART = 0;
}
namespace Impacto::Profile::ConfigSystem {
inline uint8_t AutoQuickSave = 0;
enum AutoQuickSaveType { OnScene = 1, OnTrigger = 2 };
}
`);
    fs.writeFileSync(path.join(root, "mem.h"), `#pragma once
#include <array>
namespace Impacto {
inline std::array<int, 100> ScrWork{}, Flags{};
inline void SetFlag(uint32_t id, uint32_t value) { Flags.at(id) = value; }
inline bool GetFlag(uint32_t id) { return Flags.at(id) != 0; }
}
`);
    fs.writeFileSync(path.join(data, "savesystem.h"), `#pragma once
#include <optional>
namespace Impacto::SaveSystem {
inline int Checkpoint = -1; inline unsigned CheckpointWrites = 0, Memories = 0;
enum class SaveType { Quick };
inline void SetCheckpointId(int id) { Checkpoint = id; ++CheckpointWrites; }
inline std::optional<int> GetQuickSaveOpenSlot() { return {}; }
inline void FlushWorkingSaveEntry(SaveType, int, int) {}
inline void SaveThumbnailData() {}
inline void SaveMemory() { ++Memories; }
inline void SetQSavedOnCurrentLine(bool) {}
}
namespace Impacto::SaveIconDisplay { inline void ShowFor(float) {} }
`);
    const originalPath = path.resolve(__dirname, "../producers/maclauncher/src/external/impacto/src/vm/inst_system.cpp");
    const original = fs.existsSync(originalPath) && fs.readFileSync(originalPath, "utf8")
      .match(/VmInstruction\(InstAutoSaveOld\) \{\n[\s\S]*?\n\}/)?.[0];
    assert.ok(original, "the pinned upstream save instruction is required for the legacy comparison");
    const fixture = path.join(root, "fixture.cpp"), executable = path.join(root, "fixture");
    fs.writeFileSync(fixture, `#include "windows-checkpoint.h"
#include "inst_system.h"
#include "inst_macros.inc"
#include "../data/savesystem.h"
#include "../mem.h"
#include "../profile/scriptvars.h"
#include <cassert>
#include <iostream>
#define ImpLog(...) (void)0
namespace Impacto::Vm {
using namespace Impacto::Profile::ScriptVars;
${original}
}
using namespace Impacto;
using namespace Impacto::Vm;
void reset() {
  BlockCurrentScriptThread = false; Flags.fill(0); ScrWork.fill(0);
  SaveSystem::Checkpoint = -1; SaveSystem::CheckpointWrites = 0; SaveSystem::Memories = 0;
}
template<class F> void rejects(F action) { bool rejected = false; try { action(); } catch(const std::runtime_error&) { rejected = true; } assert(rejected); }
int main() {
  for (auto value : {0, 8, 256, 65535}) {
    reset(); Sc3VmThread checkpoint{{0x10,0x22,10,uint8_t(value),uint8_t(value >> 8),0x10,0x22,5}};
    InstWindowsAutoSave(&checkpoint,0);
    assert(checkpoint.IpOffset == 5 && checkpoint.GetIp()[0] == 0x10 && checkpoint.GetIp()[1] == 0x22);
    assert(SaveSystem::Checkpoint == value && SaveSystem::CheckpointWrites == 1);
    assert(Flags[Profile::ScriptVars::SF_SAVECAPTURE] == 1 && BlockCurrentScriptThread);
    BlockCurrentScriptThread = false; InstWindowsAutoSave(&checkpoint,0);
    assert(checkpoint.IpOffset == 8 && SaveSystem::CheckpointWrites == 1 && SaveSystem::Memories == 1);
  }
  reset(); Sc3VmThread exactEnd{{0x10,0x22,10,0x34,0x12}};
  InstWindowsAutoSave(&exactEnd,0); assert(exactEnd.IpOffset == 5 && SaveSystem::Checkpoint == 0x1234);
  for (auto bytes : {std::vector<uint8_t>{}, {0x10}, {0x10,0x22}, {0x10,0x22,10}, {0x10,0x22,10,8}}) {
    reset(); Sc3VmThread truncated{bytes}; rejects([&] { InstWindowsAutoSave(&truncated,0); });
    assert(truncated.IpOffset == 0 && !BlockCurrentScriptThread && SaveSystem::CheckpointWrites == 0 && Flags[42] == 0);
  }
  for (auto type : {0,1,2,3,4,5,9,11,20,21,255}) {
    reset(); Sc3VmThread delegated{{0x10,0x22,uint8_t(type),0x10,0x22,0x0a}};
    InstWindowsAutoSave(&delegated,0); const auto flags = Flags; const auto scr = ScrWork;
    const auto block = BlockCurrentScriptThread;
    const auto memories = SaveSystem::Memories;
    assert(delegated.IpOffset == 3 && SaveSystem::CheckpointWrites == 0);
    reset(); Sc3VmThread legacy{{0x10,0x22,uint8_t(type),0x10,0x22,0x0a}};
    InstAutoSaveOld(&legacy,0);
    assert(legacy.IpOffset == delegated.IpOffset && Flags == flags && ScrWork == scr);
    assert(BlockCurrentScriptThread == block && SaveSystem::Memories == memories);
  }
  reset(); Sc3VmThread console{{0x10,0x22,10,8,0,0x10,0x22,5}};
  InstAutoSaveOld(&console,0);
  assert(console.IpOffset == 3 && SaveSystem::CheckpointWrites == 0 && BlockCurrentScriptThread);
  std::cout << "Windows checkpoint operand and legacy boundaries pass\\n";
}
`);
    execFileSync("/usr/bin/clang++", ["-std=c++20", "-arch", "arm64", "-mmacosx-version-min=13.0",
      "-I", nativeRoot, "-I", vm, path.join(nativeRoot, "windows-checkpoint.cpp"), fixture, "-o", executable], { stdio: "pipe" });
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "Windows checkpoint operand and legacy boundaries pass\n");
  });
