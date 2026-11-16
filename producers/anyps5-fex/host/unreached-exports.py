# SPDX-License-Identifier: GPL-2.0-only
# Writes arm64 definitions for the AnyPS5 runtime symbols an object references but the proof does not link: the
# rest of libkernel and libc. Each stops the process if reached, except registrations that run during static
# initialization, which return.
# Usage: unreached-exports.py <object.o> <link-errors.log> <out.s>
import re
import subprocess
import sys

obj, log, out = sys.argv[1:4]
wanted = set(re.findall(r'^  "(.*)", referenced from:', open(log).read(), re.M))
lines = ['.text']
for symbol in subprocess.run(['nm', '-u', obj], capture_output=True, text=True, check=True).stdout.split():
    readable = subprocess.run(['c++filt', symbol], capture_output=True, text=True, check=True).stdout.strip()
    if symbol not in wanted and readable not in wanted:
        continue
    body = 'ret' if symbol.startswith('_Register') else 'brk #0xf00d'
    lines += ['.globl ' + symbol, '.p2align 2', symbol + ':', '  ' + body]
open(out, 'w').write('\n'.join(lines) + '\n')
print(len(lines) // 4 if len(lines) > 1 else 0, 'symbols')
