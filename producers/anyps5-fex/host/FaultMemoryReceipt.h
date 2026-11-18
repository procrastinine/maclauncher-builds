// SPDX-License-Identifier: GPL-2.0-only
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <unistd.h>

namespace FexGuest {

inline bool ReadFaultMemory(std::uint64_t Address, void* Out, std::size_t Size) {
  mach_vm_size_t Read = 0;
  return mach_vm_read_overwrite(mach_task_self(), Address, Size, reinterpret_cast<mach_vm_address_t>(Out), &Read) == KERN_SUCCESS && Read == Size;
}

// Report actual operands first. Recognize the allocator's load only when its instruction bytes and calculated
// address agree with the fault and the spilled registers identify both operands as the same block.
inline std::uint64_t ReportFaultMemory(int Fd, std::uint64_t Rip, bool Spilled, std::uint64_t Rax,
                                       std::uint64_t Rdx, std::uint64_t Rsi, std::uint64_t Address) {
  constexpr std::uint8_t Load[] = {0x48, 0x8b, 0x4c, 0x32, 0x10};
  std::uint8_t Instruction[sizeof(Load)] {};
  const bool ReadCode = ReadFaultMemory(Rip, Instruction, sizeof(Instruction));
  const bool Decoded = ReadCode && std::memcmp(Instruction, Load, sizeof(Load)) == 0;
  const auto Effective = Rdx + Rsi + 0x10;
  const bool Identified = Spilled && Decoded && Effective == Address && Rdx == Rsi &&
                          Rdx >= 0x10000 && Rdx < 0x800000000000ULL && (Rdx & 7) == 0;
  char Text[440];
  const auto Write = [&](int Size) {
    if (Size > 0) static_cast<void>(::write(Fd, Text, std::min(static_cast<std::size_t>(Size), sizeof(Text) - 1)));
  };
  Write(std::snprintf(Text, sizeof(Text),
      "[fault-operands] rip=0x%llx registers=%s rax=0x%llx rdx=0x%llx rsi=0x%llx fault=0x%llx code_read=%d instruction=%02x%02x%02x%02x%02x effective=0x%llx allocator=%s\n",
      static_cast<unsigned long long>(Rip), Spilled ? "spilled" : "saved", static_cast<unsigned long long>(Rax),
      static_cast<unsigned long long>(Rdx), static_cast<unsigned long long>(Rsi), static_cast<unsigned long long>(Address),
      ReadCode, Instruction[0], Instruction[1], Instruction[2], Instruction[3], Instruction[4],
      static_cast<unsigned long long>(Decoded ? Effective : 0), Identified ? "identified" : "unresolved"));
  if (!Identified) return 0;

  const auto Word = Rdx + 8;
  std::uint64_t Words[2] {};
  const bool ReadHeader = ReadFaultMemory(Rdx, Words, sizeof(Words));
  mach_vm_address_t Start = Word;
  mach_vm_size_t Length = 0;
  vm_region_submap_info_data_64_t Info {};
  natural_t Depth = 0;
  bool Mapped = false;
  for (; Depth < 16; ++Depth) {
    mach_msg_type_number_t Count = VM_REGION_SUBMAP_INFO_COUNT_64;
    if (mach_vm_region_recurse(mach_task_self(), &Start, &Length, &Depth, reinterpret_cast<vm_region_recurse_info_t>(&Info), &Count) != KERN_SUCCESS ||
        Start > Word || Word - Start >= Length) break;
    if (!Info.is_submap) { Mapped = true; break; }
  }
  Write(std::snprintf(Text, sizeof(Text),
      "[fault-allocator] header=0x%llx word=0x%llx bytes=8 header_read=%d previous=0x%llx size_word=0x%llx mapped=%d region=0x%llx+0x%llx object=0x%x offset=0x%llx prot=%d/%d\n",
      static_cast<unsigned long long>(Rdx), static_cast<unsigned long long>(Word), ReadHeader,
      static_cast<unsigned long long>(Words[0]), static_cast<unsigned long long>(Words[1]), Mapped,
      static_cast<unsigned long long>(Mapped ? Start : 0), static_cast<unsigned long long>(Mapped ? Length : 0),
      Mapped ? Info.object_id : 0, static_cast<unsigned long long>(Mapped ? Info.offset + Word - Start : 0),
      Mapped ? Info.protection : 0, Mapped ? Info.max_protection : 0));
  return Word;
}

} // namespace FexGuest
