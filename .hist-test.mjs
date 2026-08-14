import { createInterface } from "readline";
import { fs } from '/root/src/sh2runtime/src/fs/index.js';
// unit-test expandHistory in isolation
const src = (await import('node:fs/promises')).readFile('/root/src/sh2runtime/src/jtsh.js', 'utf8');
// extract the function via eval of a small harness
