const requirements = require("./support/requirements.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Current = require("../producers/package-support/src/modules/mages/native/current-build");
const patchFiles = require('../producers/package-support/src/modules/mages/native/source-patches').patchFiles(
  path.join(__dirname, '../producers/package-support/src/modules/mages/native/current-windows.patch'));

// The session sources are the files current-windows.patch creates in src/vm.
const sessionFiles = require("./helpers/patch-new-files.cjs").patchNewFiles(
  path.join(__dirname, "../producers/package-support/src/modules/mages/native/current-windows.patch"));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("the current Windows voice patch validates inputs before writes and supplies the compiled implementation",
  requirements({ sourceTree: 'producers/package-support/src/external/impacto' }), async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-current-voice-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source"), upstream = path.resolve(__dirname, "../producers/package-support/src/external/impacto");
    fs.mkdirSync(source);
    for (const file of patchFiles) {
      const original = path.join(upstream, file), target = path.join(source, file);
      if (!fs.existsSync(original)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(original, target);
    }
    const first = path.join(source, "CMakeLists.txt"), original = fs.readFileSync(first);
    fs.writeFileSync(first, "changed source\n");
    await assert.rejects(Current.applyCurrentOverlay(source, { logPath: path.join(root, "overlay.log") }), /Native build command failed/);
    assert.equal(fs.existsSync(path.join(source, "src/vm/windows-audio.cpp")), false);
    fs.writeFileSync(first, original);
    await Current.applyCurrentOverlay(source, { logPath: path.join(root, "overlay.log") });
    for (const extension of ["cpp", "h"])
      assert.deepEqual(fs.readFileSync(path.join(source, "src/vm/windows-audio." + extension)),
        Buffer.from(sessionFiles["src/vm/windows-audio." + extension]));
  });

test("compiled Windows voice instructions consume full operands, yield and wait without changing legacy widths",
  { skip: process.platform !== "darwin" }, t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-audio-native-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const vm = path.join(root, "vm"), audio = path.join(root, "audio");
    fs.mkdirSync(vm); fs.mkdirSync(audio);
    // The fixture supplies only bounded operand reads and audio calls. The
    // production instruction implementation is compiled unchanged below.
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
  void SetIp(uint8_t* pointer) { IpOffset = static_cast<uint32_t>(pointer - Bytes.data()); }
};
inline bool BlockCurrentScriptThread = false;
inline unsigned ExpressionCount = 0;
}
#define VmInstruction(name) void name(Impacto::Vm::Sc3VmThread* thread, float dt)
`);
    fs.writeFileSync(path.join(vm, "inst_macros.inc"), `#define StartInstruction auto* _oldIp = thread->GetIp(2); (void)_oldIp; thread->IpOffset += 2
#define ResetInstruction thread->SetIp(_oldIp)
#define BlockThread BlockCurrentScriptThread = true
#define PopUint8(name) uint8_t name = *thread->GetIp(); thread->IpOffset += 1
#define PopExpression(name) [[maybe_unused]] int name = ExpressionEval(thread)
`);
    fs.writeFileSync(path.join(vm, "expression.h"), `#pragma once
#include "vm.h"
namespace Impacto::Vm {
inline int ExpressionEval(Sc3VmThread* thread) {
  ++ExpressionCount;
  auto byte = [&] { auto value = *thread->GetIp(); ++thread->IpOffset; return value; };
  const auto token = byte();
  if (!(token & 0x80)) throw std::runtime_error("fixture needs one immediate operand");
  int value = token & 0x1f;
  if ((token & 0x60) == 0x20) value = value * 256 + byte();
  else if ((token & 0x60) != 0) throw std::runtime_error("fixture immediate width");
  if (token & 0x10) value |= (token & 0x60) == 0x20 ? ~0x1fff : ~0x1f;
  if (byte() != 0 || byte() != 0) throw std::runtime_error("unterminated expression");
  return value;
}
}
`);
    fs.writeFileSync(path.join(audio, "audiochannel.h"), `#pragma once
#include <string>
#include <cstdint>
namespace Impacto::Audio {
enum AudioChannelState { ACS_Stopped, ACS_Playing, ACS_Paused, ACS_FadingIn, ACS_FadingOut };
struct AudioChannel {
  AudioChannelState State = ACS_Stopped;
  unsigned Plays = 0, Stops = 0; uint32_t File = 0; bool Loop = true; float Fade = -1;
  void Play(std::string const& mount, uint32_t file, bool loop, float fade) {
    if (mount != "voice") throw std::runtime_error("unexpected mount");
    ++Plays; File = file; Loop = loop; Fade = fade; State = ACS_Playing;
  }
  void Stop(float fade) { ++Stops; Fade = fade; if (fade == 0) State = ACS_Stopped; }
  AudioChannelState GetState() const { return State; }
};
}
`);
    fs.writeFileSync(path.join(audio, "audiosystem.h"), `#pragma once
#include "audiochannel.h"
#include <array>
#include <memory>
namespace Impacto::Audio {
inline constexpr unsigned AC_VOICE0 = 2;
inline std::array<std::unique_ptr<AudioChannel>, 8> Channels;
}
`);
    const inheritedSource = path.resolve(__dirname, "../producers/package-support/src/external/impacto/src/vm/inst_sound.cpp");
    let inherited = "";
    if (fs.existsSync(inheritedSource)) {
      const text = fs.readFileSync(inheritedSource, "utf8");
      inherited = text.match(/VmInstruction\(InstVoiceStop\) \{\n[\s\S]*?\n\}/)?.[0];
      assert.ok(inherited);
    }
    const fixture = path.join(root, "fixture.cpp"), executable = path.join(root, "fixture");
    fs.writeFileSync(fixture, `#include "windows-audio.h"
#include "vm.h"
#include "inst_macros.inc"
#include "expression.h"
#include "../audio/audiosystem.h"
#include <cassert>
#include <iostream>
namespace Impacto::Vm { ${inherited} }
using namespace Impacto::Vm;
using namespace Impacto::Audio;
void reset() {
  BlockCurrentScriptThread = false; ExpressionCount = 0;
  for (auto& channel : Channels) channel = std::make_unique<AudioChannel>();
}
template<class F> void rejects(F action) { bool rejected = false; try { action(); } catch(const std::runtime_error&) { rejected = true; } assert(rejected); }
int main() {
  reset();
  // The fade expression must be consumed; its 0x80 byte is not an End opcode.
  Sc3VmThread stop{{0x00,0x38,0,0x80,0,0,0xfe,0x28}};
  InstWindowsVoiceStop(&stop, 1.0f / 60); assert(stop.IpOffset == 6 && *stop.GetIp() == 0xfe);
  assert(ExpressionCount == 1 && BlockCurrentScriptThread && Channels[AC_VOICE0]->Stops == 1);
  reset(); Sc3VmThread fade{{0x00,0x38,5,0xa0,60,0,0,0xfe}};
  InstWindowsVoiceStop(&fade, 1.0f / 60); assert(fade.IpOffset == 7);
  assert(Channels[AC_VOICE0 + 2]->Fade == 1.0f && BlockCurrentScriptThread);
  reset(); Sc3VmThread play{{0x00,0x37,4,0x85,0,0,0x81,0,0,0xfe}};
  InstWindowsVoicePlay(&play, 1.0f / 60); assert(play.IpOffset == 9 && ExpressionCount == 2);
  assert(Channels[AC_VOICE0 + 1]->File == 5 && !Channels[AC_VOICE0 + 1]->Loop && BlockCurrentScriptThread);
  reset(); Sc3VmThread clear{{0x00,0x37,0,0x9f,0,0,0x80,0,0,0xfe}};
  InstWindowsVoicePlay(&clear, 1.0f / 60); assert(Channels[AC_VOICE0]->Stops == 1 && Channels[AC_VOICE0]->Plays == 0);
  for (auto state : {ACS_Playing, ACS_Paused, ACS_FadingIn, ACS_FadingOut}) {
    reset(); Channels[AC_VOICE0]->State = state; Sc3VmThread wait{{0x00,0x39,0,0xfe}};
    InstWindowsVoiceWait(&wait, 1.0f / 60); assert(wait.IpOffset == 0 && BlockCurrentScriptThread);
    Channels[AC_VOICE0]->State = ACS_Stopped; BlockCurrentScriptThread = false;
    InstWindowsVoiceWait(&wait, 1.0f / 60); assert(wait.IpOffset == 3 && !BlockCurrentScriptThread);
  }
  for (auto code : {std::vector<uint8_t>{0x00,0x38}, {0x00,0x38,0}, {0x00,0x38,0,0x80}, {0x00,0x38,0,0x80,0}, {0x00,0x38,0,0x80,0,1}}) {
    reset(); Sc3VmThread bad{code}; rejects([&] { InstWindowsVoiceStop(&bad, 0); });
    assert(Channels[AC_VOICE0]->Stops == 0);
  }
  reset(); Sc3VmThread negative{{0x00,0x38,0,0x9f,0,0}};
  rejects([&] { InstWindowsVoiceStop(&negative, 0); });
  reset(); Sc3VmThread channel{{0x00,0x38,255,0x80,0,0}};
  rejects([&] { InstWindowsVoiceStop(&channel, 0); });
  ${inherited ? "reset(); Sc3VmThread legacy{{0x00,0x38,1,0x00,0x12}}; InstVoiceStop(&legacy,0); assert(legacy.IpOffset==3 && ExpressionCount==0 && !BlockCurrentScriptThread);" : ""}
  std::cout << "Windows voice operands and wait semantics pass\\n";
}
`);
    const native = path.join(root, "native"); fs.mkdirSync(native);
    for (const extension of ["cpp", "h"]) fs.writeFileSync(path.join(native, "windows-audio." + extension), sessionFiles["src/vm/windows-audio." + extension]);
    execFileSync("/usr/bin/clang++", ["-std=c++20", "-arch", "arm64", "-mmacosx-version-min=13.0",
      "-I", native, "-I", vm, path.join(native, "windows-audio.cpp"), fixture, "-o", executable], { stdio: "pipe" });
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "Windows voice operands and wait semantics pass\n");
  });
