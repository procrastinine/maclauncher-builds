import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applyBdaRangeMemoOverlay,lookupFile} from '../producers/anyps5/overlays/bda-range-memo/apply.mjs';

const upstream=process.env.ANYPS5_TEST_SOURCE||fileURLToPath(new URL('../sources/anyps5/',import.meta.url));
const header=fileURLToPath(new URL('../producers/anyps5/overlays/bda-range-memo/BdaRangeMemo.hpp',import.meta.url));
const skip=fs.existsSync(path.join(upstream,lookupFile))?false:'Source tree sources/anyps5 is not initialized.';

function projection(t,adapt=source=>source){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'anyps5-bda-memo-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const target=path.join(root,lookupFile);
 fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.mkdirSync(path.join(root,'core/shader/recompiler/SpirvBackend/include/SpirvBackend'),{recursive:true});
 fs.writeFileSync(target,adapt(fs.readFileSync(path.join(upstream,lookupFile),'utf8')));
 return root;
}
function body(source,signature){
 const start=source.indexOf(signature),end=source.indexOf('\n}\n',start);
 assert.ok(start>=0&&end>start,signature);
 return source.slice(start,end)+'\n}\n';
}

test('every non-range lookup checks its memo before the table checks and refreshes it after a successful search',{skip},async t=>{
 const root=projection(t);
 await applyBdaRangeMemoOverlay(root);
 const source=fs.readFileSync(path.join(root,lookupFile),'utf8');
 const lookup=body(source,'std::uint32_t DefineBdaLookup(');
 const hit=lookup.indexOf('const auto hit = BdaRangeMemo::Hit(ops, address, bytes, memoBegin, memoBound);');
 const branch=lookup.indexOf('state.module.AddFunction(spv::OpBranchConditional, hit, hitLabel, miss);');
 const table=lookup.indexOf('state.module.AddFunction(spv::OpArrayLength, u32, length, state.bdaPagetableVariable, 0u);');
 const search=lookup.indexOf('state.module.AddFunction(spv::OpLoopMerge, merge, continuation, spv::LoopControlMaskNone);');
 assert.ok(hit>0&&hit<branch&&branch<table&&table<search,'the memo check precedes the header checks and the search');
 assert.match(lookup,/EmitLabel\(state, hitLabel\);\n        leave\(BdaRangeMemo::Translate\(ops, address, memoBegin, memoBase\)\);\n        EmitLabel\(state, miss\);/);
 const success=lookup.slice(lookup.indexOf('    } else {\n        if (memo != nullptr) {'));
 const store=success.indexOf('state.module.AddFunction(spv::OpStore, memo->bound, BdaRangeMemo::Bound(ops, begin, finish, base, next, last));');
 assert.ok(store>0&&store<success.indexOf('        leave(result);'),'the memo is refreshed only on the success path');
 assert.ok(lookup.indexOf('failFirst({\n        {binary(spv::OpINotEqual, boolean, BdaLoadWord(state, at(7))')<lookup.indexOf('    } else {\n        if (memo != nullptr) {'),'the range checks precede the refresh');
 const pointers=body(source,'void DefineGetBdaPointer(SpirvEmitterState& state) {');
 assert.match(pointers,/DefineBdaLookup\(state, "get_bda_pointer", true, BdaAbi::Read, false, &readMemo\)/);
 assert.match(pointers,/DefineBdaLookup\(state, "probe_bda_pointer", false, BdaAbi::Read, false, &readMemo\)/,'span readers go through the read memo');
 assert.match(pointers,/DefineBdaLookup\(state, "get_bda_write_pointer", true, BdaAbi::Write, false, &writeMemo\)/);
 assert.match(pointers,/DefineBdaLookup\(state, "probe_bda_write_pointer", false, BdaAbi::Write, false, &writeMemo\)/);
 assert.match(pointers,/DefineBdaLookup\(state, "get_bda_atomic_pointer", true, BdaAbi::Read \| BdaAbi::Write, false, &atomicMemo\)/);
 assert.match(body(source,'void DefineBdaAnchorFunction(SpirvEmitterState& state) {'),/DefineBdaLookup\(state, "bda_anchor_range", false, BdaAbi::Read, true\);/,'the anchor range search keeps no memo');
});

test('note_bda_write starts as done for a page this invocation already noted',{skip},async t=>{
 const root=projection(t);
 await applyBdaRangeMemoOverlay(root);
 const note=body(fs.readFileSync(path.join(root,lookupFile),'utf8'),'static std::uint32_t DefineBdaNoteWrite(SpirvEmitterState& state) {');
 assert.doesNotMatch(note,/OpStore, done, ConstantBool\(state, false\)/);
 const seen=note.indexOf('state.module.AddFunction(spv::OpStore, done, seen);');
 assert.ok(seen>note.indexOf('const auto bit = ')&&seen<note.indexOf('state.module.AddFunction(spv::OpLoopMerge, merge, continuation, spv::LoopControlMaskNone);'));
 assert.ok(seen<note.indexOf('spv::OpAtomicLoad'),'the check precedes the first atomic');
});

test('unrecognized BDA lookup anchors are refused',{skip},async t=>{
 for(const [anchor,changed] of [
  ['    } else {\n        leave(result);\n    }\n','    } else { leave(result); }\n'],
  ['state.module.AddFunction(spv::OpStore, done, ConstantBool(state, false));','state.module.AddFunction(spv::OpStore, done, ConstantBool(state, 0));'],
 ]){
  const root=projection(t,source=>source.replace(anchor,changed));
  await assert.rejects(applyBdaRangeMemoOverlay(root),/BDA lookup source changed/);
 }
});

// Host model: the same BdaRangeMemo templates over plain integers, against a reference lookup with
// the emitted search and checks (header validity is a constant of the table and left out).
const fixture=`#include "BdaRangeMemo.hpp"
#include <cstdint>
#include <cstdio>
#include <optional>
#include <vector>
using namespace ShaderRecompiler;
struct Host {
    std::uint32_t U32(std::uint32_t v) { return v; }
    std::uint64_t U64(std::uint64_t v) { return v; }
    std::uint64_t Add64(std::uint64_t a, std::uint64_t b) { return a + b; }
    std::uint64_t Sub64(std::uint64_t a, std::uint64_t b) { return a - b; }
    std::uint64_t Widen(std::uint32_t v) { return v; }
    bool Ult64(std::uint64_t a, std::uint64_t b) { return a < b; }
    bool Ule64(std::uint64_t a, std::uint64_t b) { return a <= b; }
    bool Ugt64(std::uint64_t a, std::uint64_t b) { return a > b; }
    bool Uge64(std::uint64_t a, std::uint64_t b) { return a >= b; }
    bool Eq32(std::uint32_t a, std::uint32_t b) { return a == b; }
    bool Ne32(std::uint32_t a, std::uint32_t b) { return a != b; }
    bool And(bool a, bool b) { return a && b; }
    bool Or(bool a, bool b) { return a || b; }
    std::uint32_t And32(std::uint32_t a, std::uint32_t b) { return a & b; }
    std::uint32_t Or32(std::uint32_t a, std::uint32_t b) { return a | b; }
    std::uint32_t Select32(bool c, std::uint32_t a, std::uint32_t b) { return c ? a : b; }
    std::uint64_t Select64(bool c, std::uint64_t a, std::uint64_t b) { return c ? a : b; }
};
enum : std::uint32_t { Read = 1, Write = 2 };
struct Range { std::uint64_t begin, end, base; std::uint32_t permissions; };
struct Found { std::uint64_t device, begin, finish, base, next; bool last; };
// DefineBdaLookup's search: the last entry starting at or below the address, then its range checks.
static std::optional<Found> Search(const std::vector<Range>& table, std::uint64_t address, std::uint32_t bytes, std::uint32_t permission) {
    const std::uint64_t end = address + bytes;
    if (bytes == 0 || end <= address) return std::nullopt;
    std::uint32_t lower = 0, upper = static_cast<std::uint32_t>(table.size());
    while (lower < upper) {
        const auto mid = lower + ((upper - lower) >> 1);
        if (address < table[mid].begin) upper = mid; else lower = mid + 1;
    }
    if (lower == 0) return std::nullopt;
    const auto& r = table[lower - 1];
    const std::uint64_t device = r.base + (address - r.begin), deviceEnd = device + bytes;
    if (r.begin >= r.end || end > r.end || (r.permissions & permission) != permission || r.base == 0 || device < r.base || deviceEnd <= device) return std::nullopt;
    const bool last = lower >= table.size();
    return Found{device, r.begin, r.end, r.base, table[last ? lower - 1 : lower].begin, last};
}
struct Memo { std::uint64_t begin = 0, bound = 0, base = 0; std::uint64_t hits = 0, searches = 0; };
static std::optional<std::uint64_t> Lookup(const std::vector<Range>& table, Memo& memo, std::uint64_t address, std::uint32_t bytes, std::uint32_t permission) {
    Host b;
    if (BdaRangeMemo::Hit(b, address, bytes, memo.begin, memo.bound)) {
        ++memo.hits;
        return BdaRangeMemo::Translate(b, address, memo.begin, memo.base);
    }
    ++memo.searches;
    const auto found = Search(table, address, bytes, permission);
    if (!found) return std::nullopt;
    memo.begin = found->begin;
    memo.base = found->base;
    memo.bound = BdaRangeMemo::Bound(b, found->begin, found->finish, found->base, found->next, found->last);
    return found->device;
}
static int failures = 0;
static void Check(bool ok, const char* what) { if (!ok) { std::fprintf(stderr, "FAIL %s\\n", what); ++failures; } }
static void Same(const std::vector<Range>& table, Memo& memo, std::uint64_t address, std::uint32_t bytes, std::uint32_t permission, const char* what) {
    const auto reference = Search(table, address, bytes, permission);
    const auto memoized = Lookup(table, memo, address, bytes, permission);
    Check(reference.has_value() == memoized.has_value() && (!reference || reference->device == *memoized), what);
}
int main() {
    // Adjacent ranges, an overlapping pair (0x5000 starts inside 0x4000's range), a read-only range.
    const std::vector<Range> table{
        {0x1000, 0x2000, 0x10000, Read | Write},
        {0x2000, 0x3000, 0x80000, Read | Write},
        {0x4000, 0x6000, 0x20000, Read | Write},
        {0x5000, 0x5800, 0x90000, Read | Write},
        {0x7000, 0x8000, 0x30000, Read},
    };
    {
        Memo memo;
        Same(table, memo, 0x1100, 4, Read, "first lookup");
        Check(memo.searches == 1 && memo.hits == 0, "the first lookup searches");
        Same(table, memo, 0x1ffc, 4, Read, "access ending at the range end");
        Check(memo.hits == 1, "an access ending at the bound hits");
        Same(table, memo, 0x1ffe, 4, Read, "access straddling the range end");
        Same(table, memo, 0x2000, 4, Read, "address at the range end");
        Check(memo.searches == 3, "an address at the bound searches and selects the next range");
        Same(table, memo, 0x2004, 0, Read, "zero bytes");
        Same(table, memo, ~0ull - 1, 4, Read, "a wrapping access");
    }
    {
        // A loop alternating between two buffers: every step equals the search.
        Memo memo;
        for (int i = 0; i < 64; ++i) {
            Same(table, memo, 0x1000 + 16 * i, 16, Read, "loop over the first buffer");
            Same(table, memo, 0x7000 + 16 * i, 16, Read, "loop over the second buffer");
            if (i == 31) Same(table, memo, 0x7ff8, 16, Read, "an access past the second buffer mid-loop");
        }
        Memo sequential;
        for (int i = 0; i < 64; ++i) Same(table, sequential, 0x1000 + 16 * i, 16, Read, "sequential loop");
        Check(sequential.searches == 1 && sequential.hits == 63, "one search for a loop inside one range");
    }
    {
        // Overlap: from the range at 0x4000, the memo ends where the next entry starts.
        Memo memo;
        Same(table, memo, 0x4100, 4, Read, "below the overlapping entry");
        Check(memo.bound == 0x5000, "the bound stops at the next entry");
        Same(table, memo, 0x5100, 4, Read, "inside the overlapping entry");
        Same(table, memo, 0x5900, 4, Read, "past the overlapping entry's end");
    }
    {
        // Write variant: a write memo of its own; a read-only range never enters it.
        Memo read, write;
        Same(table, read, 0x7100, 4, Read, "read of the read-only range");
        Same(table, write, 0x7100, 4, Write, "write to the read-only range");
        Check(write.bound == 0 && write.hits == 0, "a refused write leaves the write memo empty");
        Same(table, write, 0x1100, 4, Write, "write to a writable range");
        Same(table, write, 0x1200, 8, Write, "second write to the same range");
        Check(write.hits == 1, "the write memo hits");
        Same(table, write, 0x7100, 4, Write, "write to the read-only range after a write hit");
    }
    {
        // A device span that would wrap is never remembered.
        const std::vector<Range> wrap{{0x1000, 0x3000, ~0ull - 0x1800, Read}};
        Memo memo;
        Same(wrap, memo, 0x1000, 4, Read, "below the wrap");
        Check(memo.bound == 0, "a wrapping device span keeps the memo empty");
        Same(wrap, memo, 0x2900, 4, Read, "across the wrap");
    }
    {
        // note_bda_write: the first note of every page reaches the table; repeats are skipped.
        std::uint32_t lastKey = 0, lastMask = 0, notes = 0, skipped = 0;
        std::vector<std::pair<std::uint32_t, std::uint32_t>> table;
        const auto note = [&](std::uint32_t key, std::uint32_t page) {
            Host b;
            const std::uint32_t bit = 1u << page;
            const bool seen = BdaRangeMemo::Seen(b, key, bit, lastKey, lastMask);
            lastMask = BdaRangeMemo::NotedMask(b, key, bit, lastKey, lastMask);
            lastKey = key;
            if (seen) { ++skipped; return; }
            ++notes;
            for (auto& [k, mask] : table) if (k == key) { mask |= bit; return; }
            table.push_back({key, bit});
        };
        note(1, 0); note(1, 0); note(1, 3); note(1, 0); note(1, 3);
        Check(notes == 2 && skipped == 3, "repeat notes of a page are skipped");
        note(2, 0); note(1, 3); note(1, 5); note(2, 0);
        Check(table.size() == 2 && table[0].second == ((1u << 0) | (1u << 3) | (1u << 5)) && table[1].second == 1u, "every page's first note reached the table");
        Check(notes == 6, "a region change notes again");
        std::uint32_t freshKey = 0, freshMask = 0;
        Host b;
        Check(!BdaRangeMemo::Seen(b, 0u, 1u, freshKey, freshMask), "the initial memo never skips");
    }
    if (failures != 0) return 1;
    std::puts("ok");
    return 0;
}
`;

test('the memo answers exactly as the search: range ends, range changes mid-loop, overlaps, writes and repeat notes',{skip:process.platform==='win32'?'Fixture uses a POSIX compiler.':false},t=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'anyps5-bda-memo-host-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.copyFileSync(header,path.join(directory,'BdaRangeMemo.hpp'));
 fs.writeFileSync(path.join(directory,'memo.cpp'),fixture);
 const compiler=process.env.CXX||(fs.existsSync('/usr/bin/clang++')?'/usr/bin/clang++':'c++');
 const built=spawnSync(compiler,['-std=c++20','-O1','-Wall','-Werror','-o',path.join(directory,'memo'),path.join(directory,'memo.cpp')],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(path.join(directory,'memo'),{encoding:'utf8',timeout:60000});
 assert.equal(ran.status,0,ran.stderr+ran.stdout);
 assert.equal(ran.stdout.trim(),'ok');
});
