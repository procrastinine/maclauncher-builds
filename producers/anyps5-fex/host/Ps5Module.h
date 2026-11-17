// SPDX-License-Identifier: GPL-2.0-only
// Loads PS5 x86-64 ELF modules (an eboot or a PRX) into guest memory for FEXCore: maps the PT_LOAD segments at a
// kernel-chosen base, reads the dynamic symbol and relocation tables, lays out static TLS (FreeBSD variant II, the TCB
// above the blocks) and applies the relocations with a caller-supplied import resolver.
#pragma once

#include "FexGuest.h"

#include <algorithm>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace Ps5 {
// Symbol names are "<NID>#<library>#<module>"; a NID names the same function in every library.
inline std::string NidOf(const std::string& Name) {
  return Name.substr(0, Name.find('#'));
}

struct Symbol {
  std::string Name;
  std::uint8_t Info;
  std::uint16_t Section;
  std::uint64_t Value;
  bool IsObject() const {
    return (Info & 0xf) == 1;
  }
  bool IsTls() const {
    return (Info & 0xf) == 6;
  }
};

struct Relocation {
  std::uint64_t Offset;
  std::uint32_t Type;
  std::uint32_t Symbol;
  std::int64_t Addend;
};

struct Module {
  std::string Name;
  std::uint64_t Base = 0;
  std::uint64_t Entry = 0;
  std::uint64_t Init = 0;
  std::uint64_t Size = 0; // the mapped image, from Base
  std::vector<std::uint8_t> ProgramHeaders; // the ELF program header table, PhEntSize bytes each
  std::uint16_t ProgramHeaderCount = 0;
  std::uint64_t ProcParam = 0;
  std::uint64_t TlsImage = 0, TlsFileSize = 0, TlsMemSize = 0, TlsAlign = 1;
  std::uint64_t TlsOffset = 0; // the block is at TP - TlsOffset
  std::uint64_t TlsIndex = 0;  // the module's DTV index, from 1
  std::vector<Symbol> Symbols;
  std::vector<Relocation> Relocations;
  std::unordered_map<std::string, std::uint64_t> Exports; // NID -> guest address
  // The names other modules know this one by: its file name, DT_SONAME and its SCE module names.
  std::vector<std::string> Identities;
  // The modules this one imports from, by the module ID that ends each imported symbol's name.
  std::unordered_map<std::uint64_t, std::string> ImportModules;
};

// A module name without its .prx, .sprx, .suprx or .debug_prx suffix.
inline std::string ModuleStem(const std::string& Name) {
  for (const char* Suffix : {".prx", ".sprx", ".suprx", ".debug_prx"}) {
    const std::size_t Length = std::strlen(Suffix);
    if (Name.size() > Length && Name.compare(Name.size() - Length, Length, Suffix) == 0) {
      return Name.substr(0, Name.size() - Length);
    }
  }
  return Name;
}

// The module an imported symbol "<NID>#<library>#<module>" names, or "" for a name without a module ID.
inline std::string DeclaredModule(const Module& Importer, const std::string& Name) {
  const auto First = Name.find('#');
  const auto Second = First == std::string::npos ? std::string::npos : Name.find('#', First + 1);
  if (Second == std::string::npos) {
    return {};
  }
  static constexpr std::string_view Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-";
  std::uint64_t Id = 0;
  for (const char Character : std::string_view(Name).substr(Second + 1)) {
    const auto Digit = Alphabet.find(Character);
    if (Digit == std::string_view::npos) {
      return {};
    }
    Id = Id * 64 + Digit;
  }
  const auto Found = Importer.ImportModules.find(Id);
  return Found == Importer.ImportModules.end() ? std::string {} : Found->second;
}

// Whether a module is the one an import names, as AnyPS5's relinker matches them: by file name, DT_SONAME or SCE
// module name, with or without the module suffix.
inline bool Provides(const Module& M, const std::string& Declared) {
  const auto Stem = ModuleStem(Declared);
  return std::any_of(M.Identities.begin(), M.Identities.end(), [&](const std::string& Identity) {
    return Identity == Declared || ModuleStem(Identity) == Stem;
  });
}

inline std::vector<std::uint8_t> ReadFile(const std::string& Path) {
  std::vector<std::uint8_t> Data;
  FILE* File = std::fopen(Path.c_str(), "rb");
  if (!File) {
    std::perror(Path.c_str());
    std::exit(2);
  }
  std::fseek(File, 0, SEEK_END);
  Data.resize(std::ftell(File));
  std::fseek(File, 0, SEEK_SET);
  if (std::fread(Data.data(), 1, Data.size(), File) != Data.size()) {
    std::perror(Path.c_str());
    std::exit(2);
  }
  std::fclose(File);
  return Data;
}

template<class T>
T Read(const std::vector<std::uint8_t>& Data, std::size_t Offset) {
  if (Offset + sizeof(T) > Data.size()) {
    std::printf("read past the end of the module file\nFAIL\n");
    std::exit(2);
  }
  T Value;
  std::memcpy(&Value, Data.data() + Offset, sizeof(T));
  return Value;
}

template<class T>
T Guest(std::uint64_t Address) {
  T Value;
  std::memcpy(&Value, reinterpret_cast<const void*>(Address), sizeof(T));
  return Value;
}

inline Module Load(const std::string& Path, const std::string& Name) {
  constexpr std::uint32_t PT_LOAD = 1, PT_DYNAMIC = 2, PT_TLS = 7, PT_SCE_PROCPARAM = 0x61000001;
  const auto File = ReadFile(Path);
  if (std::memcmp(File.data(), "\x7f" "ELF", 4) != 0 || Read<std::uint16_t>(File, 18) != 62) {
    std::printf("%s is not an x86-64 ELF\nFAIL\n", Path.c_str());
    std::exit(2);
  }
  Module M;
  M.Name = Name;
  const std::uint64_t PhOff = Read<std::uint64_t>(File, 32), PhEntSize = Read<std::uint16_t>(File, 54), PhNum = Read<std::uint16_t>(File, 56);
  std::uint64_t End = 0, Dynamic = 0, DynamicSize = 0;
  if (PhEntSize != 56) {
    std::printf("%s has %llu-byte program headers\nFAIL\n", Path.c_str(), static_cast<unsigned long long>(PhEntSize));
    std::exit(2);
  }
  M.ProgramHeaders.assign(File.begin() + PhOff, File.begin() + PhOff + PhNum * PhEntSize);
  M.ProgramHeaderCount = static_cast<std::uint16_t>(PhNum);
  for (unsigned i = 0; i < PhNum; ++i) {
    const auto O = PhOff + i * PhEntSize;
    if (Read<std::uint32_t>(File, O) == PT_LOAD) {
      End = std::max(End, Read<std::uint64_t>(File, O + 16) + Read<std::uint64_t>(File, O + 40));
    }
  }
  const std::uint64_t PageSize = getpagesize();
  M.Size = (End + PageSize - 1) & ~(PageSize - 1);
  M.Base = reinterpret_cast<std::uint64_t>(FexGuest::MapGuest(M.Size));
  for (unsigned i = 0; i < PhNum; ++i) {
    const auto O = PhOff + i * PhEntSize;
    const auto Type = Read<std::uint32_t>(File, O);
    const auto Offset = Read<std::uint64_t>(File, O + 8), VAddr = Read<std::uint64_t>(File, O + 16);
    const auto FileSize = Read<std::uint64_t>(File, O + 32), MemSize = Read<std::uint64_t>(File, O + 40);
    if (Type == PT_LOAD) {
      std::memcpy(reinterpret_cast<void*>(M.Base + VAddr), &File.at(Offset), FileSize);
    } else if (Type == PT_DYNAMIC) {
      Dynamic = Offset;
      DynamicSize = FileSize;
    } else if (Type == PT_TLS) {
      M.TlsImage = VAddr;
      M.TlsFileSize = FileSize;
      M.TlsMemSize = MemSize;
      M.TlsAlign = std::max<std::uint64_t>(1, Read<std::uint64_t>(File, O + 48));
    } else if (Type == PT_SCE_PROCPARAM) {
      M.ProcParam = M.Base + VAddr;
    }
  }
  M.Entry = Read<std::uint64_t>(File, 24);

  std::unordered_map<std::uint64_t, std::uint64_t> Tags;
  std::vector<std::pair<std::uint64_t, std::uint64_t>> Repeated; // tags that occur once per module
  constexpr std::uint64_t DT_SONAME = 14, DT_SCE_MODULE_INFO = 0x6100000d, DT_SCE_NEEDED_MODULE = 0x6100000f,
                          DT_SCE_MODULE_INFO_PS5 = 0x61000043, DT_SCE_NEEDED_MODULE_PS5 = 0x61000045;
  for (std::uint64_t O = Dynamic; O + 16 <= Dynamic + DynamicSize; O += 16) {
    const auto Tag = Read<std::uint64_t>(File, O);
    if (Tag == 0) {
      break;
    }
    Tags.try_emplace(Tag, Read<std::uint64_t>(File, O + 8));
    if (Tag == DT_SONAME || Tag == DT_SCE_MODULE_INFO || Tag == DT_SCE_NEEDED_MODULE || Tag == DT_SCE_MODULE_INFO_PS5 ||
        Tag == DT_SCE_NEEDED_MODULE_PS5) {
      Repeated.emplace_back(Tag, Read<std::uint64_t>(File, O + 8));
    }
  }
  constexpr std::uint64_t DT_INIT = 12, DT_STRTAB = 5, DT_SYMTAB = 6, DT_RELA = 7, DT_RELASZ = 8, DT_JMPREL = 23, DT_PLTRELSZ = 2,
                          DT_SCE_SYMTABSZ = 0x6100003f;
  if (Tags.contains(DT_INIT) && Tags[DT_INIT] != 0) {
    M.Init = M.Base + Tags[DT_INIT];
  }
  const std::uint64_t Strings = M.Base + Tags.at(DT_STRTAB), SymbolTable = M.Base + Tags.at(DT_SYMTAB);
  M.Identities.push_back(Name);
  for (const auto& [Tag, Value] : Repeated) {
    const std::string Text = reinterpret_cast<const char*>(Strings + (Value & 0xffff'ffffULL));
    if (Tag == DT_SCE_NEEDED_MODULE || Tag == DT_SCE_NEEDED_MODULE_PS5) {
      M.ImportModules.try_emplace(Value >> 48, Text);
    } else if (!Text.empty()) {
      M.Identities.push_back(Text);
    }
  }
  for (std::uint64_t i = 0; i < Tags.at(DT_SCE_SYMTABSZ) / 24; ++i) {
    const std::uint64_t S = SymbolTable + i * 24;
    Symbol Entry {reinterpret_cast<const char*>(Strings + Guest<std::uint32_t>(S)), Guest<std::uint8_t>(S + 4), Guest<std::uint16_t>(S + 6),
                  Guest<std::uint64_t>(S + 8)};
    const auto Binding = Entry.Info >> 4;
    if (Entry.Section != 0 && (Binding == 1 || Binding == 2) && !Entry.Name.empty() && !Entry.IsTls()) {
      M.Exports.try_emplace(NidOf(Entry.Name), M.Base + Entry.Value);
    }
    M.Symbols.push_back(std::move(Entry));
  }
  for (auto [Table, Size] : {std::pair {DT_RELA, DT_RELASZ}, std::pair {DT_JMPREL, DT_PLTRELSZ}}) {
    if (!Tags.contains(Table) || !Tags.contains(Size)) {
      continue;
    }
    for (std::uint64_t i = 0; i < Tags[Size] / 24; ++i) {
      const std::uint64_t R = M.Base + Tags[Table] + i * 24;
      const auto Info = Guest<std::uint64_t>(R + 8);
      M.Relocations.push_back({Guest<std::uint64_t>(R), static_cast<std::uint32_t>(Info), static_cast<std::uint32_t>(Info >> 32),
                               Guest<std::int64_t>(R + 16)});
    }
  }
  std::printf("%s at 0x%llx: %zu symbols, %zu exports, %zu relocations, TLS %llu bytes\n", M.Name.c_str(),
              static_cast<unsigned long long>(M.Base), M.Symbols.size(), M.Exports.size(), M.Relocations.size(),
              static_cast<unsigned long long>(M.TlsMemSize));
  return M;
}

// Static TLS: each module's block below the thread pointer, the TCB at the thread pointer (self pointer, the DTV, then
// the thread's record for the host's pthread layer). LayOutStaticTls places the blocks once, before relocation (TPOFF64
// relocations use the offsets); AllocateStaticTls then gives each thread, the initial one included, its own copy of the
// relocated TLS images and returns its thread pointer, the guest FS base. As FreeBSD's rtld does, the static area keeps
// a surplus below the startup modules' blocks for modules loaded later (AddRuntimeTls): their code may address its TLS
// at a fixed offset from the thread pointer too.
constexpr std::uint64_t StaticTlsSurplus = 0x10000;
constexpr std::uint64_t DtvOffset = 0x1000, DtvEntries = 0x600;
struct StaticTlsLayout {
  std::vector<Module*> Modules;
  std::uint64_t Blocks = 0; // the whole static area below the thread pointer, surplus included
  std::uint64_t Used = 0;   // the offsets taken so far
  std::uint64_t Indices = 0;
  std::vector<std::uint64_t> ThreadPointers; // every thread's, for the blocks of modules loaded later
};
inline StaticTlsLayout TlsLayout;
inline std::mutex TlsLock;

inline std::uint64_t AllocateStaticTls() {
  std::lock_guard Lock(TlsLock);
  auto* Area = static_cast<std::uint8_t*>(FexGuest::MapGuest(TlsLayout.Blocks + 0x4000));
  const std::uint64_t TP = reinterpret_cast<std::uint64_t>(Area) + TlsLayout.Blocks;
  auto* Dtv = reinterpret_cast<std::uint64_t*>(TP + DtvOffset);
  Dtv[0] = 1;
  for (auto* M : TlsLayout.Modules) {
    if (M->TlsIndex == 0) {
      continue;
    }
    const std::uint64_t Block = TP - M->TlsOffset;
    std::memcpy(reinterpret_cast<void*>(Block), reinterpret_cast<const void*>(M->Base + M->TlsImage), M->TlsFileSize);
    Dtv[M->TlsIndex] = Block;
  }
  reinterpret_cast<std::uint64_t*>(TP)[0] = TP;
  reinterpret_cast<std::uint64_t*>(TP)[1] = reinterpret_cast<std::uint64_t>(Dtv);
  TlsLayout.ThreadPointers.push_back(TP);
  return TP;
}

// Places M's block after the blocks taken so far; false when the block does not fit in the static area.
inline bool PlaceTls(Module& M, std::uint64_t Limit) {
  const auto Offset = (TlsLayout.Used + M.TlsMemSize + M.TlsAlign - 1) & ~(M.TlsAlign - 1);
  if (Offset > Limit || TlsLayout.Indices + 1 >= DtvEntries) {
    return false;
  }
  TlsLayout.Used = Offset;
  M.TlsOffset = Offset;
  M.TlsIndex = ++TlsLayout.Indices;
  return true;
}

inline void LayOutStaticTls(std::vector<Module*> Modules) {
  std::uint64_t Align = 16;
  for (auto* M : Modules) {
    if (M->TlsMemSize != 0) {
      PlaceTls(*M, ~0ULL);
      Align = std::max(Align, M->TlsAlign);
    }
  }
  TlsLayout.Modules = std::move(Modules);
  TlsLayout.Blocks = (TlsLayout.Used + StaticTlsSurplus + Align - 1) & ~(Align - 1);
}

// A module loaded after the threads started: its block comes from the surplus, and every thread gets the initial image
// and the DTV entry; the threads created later get both from AllocateStaticTls.
inline bool AddRuntimeTls(Module& M) {
  std::lock_guard Lock(TlsLock);
  if (M.TlsMemSize == 0) {
    TlsLayout.Modules.push_back(&M);
    return true;
  }
  if (M.TlsAlign > 16 || !PlaceTls(M, TlsLayout.Blocks)) {
    return false;
  }
  for (const auto TP : TlsLayout.ThreadPointers) {
    std::memcpy(reinterpret_cast<void*>(TP - M.TlsOffset), reinterpret_cast<const void*>(M.Base + M.TlsImage), M.TlsFileSize);
    reinterpret_cast<std::uint64_t*>(TP + DtvOffset)[M.TlsIndex] = TP - M.TlsOffset;
  }
  TlsLayout.Modules.push_back(&M);
  return true;
}

// Applies the module's relocations. Resolve returns the guest address of an imported symbol.
inline void Relocate(Module& M, const std::function<std::uint64_t(const Symbol&)>& Resolve) {
  constexpr std::uint32_t R_64 = 1, R_GLOB_DAT = 6, R_JUMP_SLOT = 7, R_RELATIVE = 8, R_DTPMOD64 = 16, R_DTPOFF64 = 17, R_TPOFF64 = 18;
  for (const auto& R : M.Relocations) {
    auto* Target = reinterpret_cast<std::uint64_t*>(M.Base + R.Offset);
    const Symbol* S = R.Symbol ? &M.Symbols.at(R.Symbol) : nullptr;
    const auto Address = [&] {
      return S->Section != 0 ? M.Base + S->Value : Resolve(*S);
    };
    switch (R.Type) {
    case R_RELATIVE: *Target = M.Base + R.Addend; break;
    case R_64:
    case R_GLOB_DAT:
    case R_JUMP_SLOT: *Target = Address() + R.Addend; break;
    case R_DTPMOD64: *Target = M.TlsIndex; break;
    case R_DTPOFF64: *Target = (S ? S->Value : 0) + R.Addend; break;
    case R_TPOFF64: *Target = (S ? S->Value : 0) + R.Addend - M.TlsOffset; break;
    default:
      std::printf("%s: relocation type %u at 0x%llx is not handled\nFAIL\n", M.Name.c_str(), R.Type, static_cast<unsigned long long>(R.Offset));
      std::exit(1);
    }
  }
}
} // namespace Ps5
