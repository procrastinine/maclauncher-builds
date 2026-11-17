#!/usr/bin/env node
// JNIGen 1.9 consumes javah-format headers. javac -h produces those headers
// while compiling the original classes; this build-only adapter places them.
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), output = args[args.indexOf('-o') + 1], name = args.at(-1);
if (args.length !== 5 || args[0] !== '-classpath' || args[2] !== '-o' || !process.env.STEAMWORKS_JNI_HEADERS || !output || !/^[\w.]+$/.test(name))
  throw new Error('Expected javah -classpath classes -o header class.');
fs.copyFileSync(path.join(process.env.STEAMWORKS_JNI_HEADERS, name.replaceAll('.', '_') + '.h'), output);
