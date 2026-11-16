# SPDX-License-Identifier: GPL-2.0-only
# Lists the unreached-export stubs that the given functions can reach through direct calls and tail calls in a linked
# arm64 binary, each with one call path. Calls through function pointers and virtual calls are not followed.
# Usage: reachable-stubs.py <binary> <unreached-exports.s> <root symbol or @file of roots>...
# A root is a Mach-O symbol (with its leading underscore) or an AnyPS5 export name: <name>_nid_postfix, else <name>.
import collections
import re
import subprocess
import sys

binary, stubs_source, roots = sys.argv[1], sys.argv[2], []
for argument in sys.argv[3:]:
    roots += open(argument[1:]).read().split() if argument.startswith('@') else [argument]
listed = set(re.findall(r'^(_[A-Za-z0-9_$.]+):', open(stubs_source).read(), re.M))
calls, function, first = collections.defaultdict(set), None, {}
disassembly = subprocess.run(['objdump', '-d', '--no-show-raw-insn', binary], capture_output=True, text=True, check=True)
for line in disassembly.stdout.splitlines():
    if (header := re.match(r'^[0-9a-f]+ <(.+)>:$', line)):
        function = header.group(1)
    elif function and function not in first and (instruction := re.match(r'^\s*[0-9a-f]+:\s+(\S+)', line)):
        first[function] = instruction.group(1)
    if function and (call := re.search(r'\t(?:bl|b)\t0x[0-9a-f]+ <([^+>]+)>$', line)):
        if call.group(1) != function:
            calls[function].add(call.group(1))
# A listed stub that a real definition replaced (the stubs are weak) is not a stub in the binary.
stubs = {symbol for symbol in listed if first.get(symbol) == 'brk'}
known = set(first) | set(calls) | {callee for callees in calls.values() for callee in callees}
starts = []
for root in roots:
    candidates = [root] if root.startswith('_') else ['_' + root + '_nid_postfix', '_' + root]
    symbol = next((candidate for candidate in candidates if candidate in known), None)
    if symbol is None:
        print('root not found: ' + root, file=sys.stderr)
        continue
    starts.append(symbol)
parent = {symbol: None for symbol in starts}
queue = collections.deque(starts)
while queue:
    current = queue.popleft()
    if current in stubs:
        continue
    for callee in sorted(calls.get(current, ())):
        if callee not in parent:
            parent[callee] = current
            queue.append(callee)
reached = sorted(symbol for symbol in parent if symbol in stubs)
for stub in reached:
    path, step = [], stub
    while step is not None:
        path.append(step)
        step = parent[step]
    readable = subprocess.run(['c++filt', '-_'] + path[::-1], capture_output=True, text=True, check=True).stdout.split('\n')
    print(' -> '.join(name for name in readable if name))
print(f'{len(reached)} stubs reachable from {len(starts)} roots', file=sys.stderr)
