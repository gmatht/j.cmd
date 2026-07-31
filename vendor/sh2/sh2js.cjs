#!/usr/bin/env node
// sh2js.js — shell → JS, via the debashl WASM library (debashl.wasm).
//
// debashl emits standard ESTree JSON (PLAN.md §1.2) with shell semantics
// lowered to calls into the documented `sh2.*` runtime namespace
// (sh2.fs.*, sh2.exec, sh2.pipeline, sh2.getVar, ...).
//
//   const { toEstree, toJs } = require('/path/to/sh2js.js');
//   const ast = await toEstree('echo hi');        // ESTree AST (object)
//   const js  = await toJs('echo hi');            // JS source (needs @babel/generator)
//
// CLI:
//   node sh2js.js 'echo hi'            # print ESTree JSON
//   node sh2js.js 'echo hi' js         # print generated JS source
'use strict';

const { loadLibrary } = require('./sh2lib');

let libPromise = null;
function lib() { return (libPromise ??= loadLibrary()); }

// shell source → ESTree AST object (the sh2runtime contract)
async function toEstree(shSource) { return (await lib()).toEstree(shSource); }
async function lex(shSource) { return (await lib()).lex(shSource); }
async function version() { return (await lib()).version(); }

// @babel/generator consumes Babel's AST, not raw ESTree: normalize Literal nodes
// (Literal → StringLiteral/NumericLiteral/BooleanLiteral/NullLiteral) and add
// Program.directives. Everything else debashl emits (MemberExpression,
// TemplateLiteral, ArrowFunctionExpression, AwaitExpression, ...) is compatible.
function estreeToBabel(node) {
  if (Array.isArray(node)) return node.map(estreeToBabel);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'raw' || k === 'extra') continue;
    out[k] = estreeToBabel(v);
  }
  if (node.type === 'Literal') {
    out.type =
      node.value === null ? 'NullLiteral'
      : typeof node.value === 'string' ? 'StringLiteral'
      : typeof node.value === 'number' ? 'NumericLiteral'
      : typeof node.value === 'boolean' ? 'BooleanLiteral'
      : 'StringLiteral';
    if (out.type === 'RegExpLiteral') {
      out.pattern = node.regex?.pattern ?? '';
      out.flags = node.regex?.flags ?? '';
    }
  }
  if (node.type === 'Program') out.directives = [];
  return out;
}

// shell source → runnable JS source via @babel/generator (optional dependency:
// `npm install @babel/generator` — or use toEstree() and generate yourself).
async function toJs(shSource) {
  const ast = await toEstree(shSource);
  let generate;
  try {
    ({ default: generate } = require('@babel/generator'));
  } catch {
    throw new Error(
      'toJs() requires @babel/generator — run `npm install @babel/generator`, or use toEstree()'
    );
  }
  return generate(estreeToBabel(ast), { compact: false }).code;
}

module.exports = { toEstree, toJs, lex, version };

if (require.main === module) {
  const source = process.argv[2];
  const mode = process.argv[3] || 'estree';
  if (!source) { console.error('usage: node sh2js.js "<shell source>" [estree|js]'); process.exit(2); }
  (mode === 'js' ? toJs(source) : toEstree(source).then(JSON.stringify))
    .then(out => process.stdout.write(typeof out === 'string' ? out + '\n' : out))
    .catch(e => { console.error('sh2js:', e.message); process.exit(1); });
}
