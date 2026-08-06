// llm v2 — agentic coder in the browser shell, pi-style four-tool core.
//   llm 'fix the bug in main.js'    agent loop (read/write/edit/bash)
//   llm --plain 'what is 2+2'       single completion (no tools)
//   llm -m MODEL 'task'             pick a model
//   llm --list                      list models (no key needed)
//   llm --base URL 'task'           custom API base (local models, e.g. ollama)
//   llm -s N 'task'                 max agent steps (default 25)
//   llm -h                          help
// Key: $LLM_API_KEY or ~/.config/llm.key
var NL = String.fromCharCode(10);
var CONFIG = ((env.HOME || "/home").replace(RegExp("/+$"), "") || "/") + "/.config/llm.key";
var API = "https://openrouter.ai/api/v1";
var DEFAULT_MODEL = "openai/gpt-4o-mini";

var TOOLS = [
  { type: "function", function: { name: "read", description: "Read a file from the virtual filesystem and return its contents (truncated if huge).", parameters: { type: "object", properties: { path: { type: "string", description: "Absolute VFS path, e.g. /home/main.js" } }, required: ["path"] } } },
  { type: "function", function: { name: "write", description: "Create or overwrite a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit", description: "Replace the first occurrence of oldText in a file with newText.", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } } },
  { type: "function", function: { name: "bash", description: "Run a shell command in the j.cmd shell (builtins, .js commands, wasm). Use for ls, cat, grep, running tests, etc.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];

var AGENT_PROMPT = "You are an agentic coding assistant running inside j.cmd, a JavaScript browser shell with a virtual filesystem. " +
  "Use the tools to inspect and modify files and run commands; work iteratively (read, edit, test, repeat) until the task is done, " +
  "then reply with a concise summary of what you changed. " +
  "Filesystem: /home (persistent), /tmp (ephemeral), /bin (commands), /github (browse GitHub), /dev, /proc, /big. " +
  "Use bash for ls and other commands.";

function usage() {
  console.log("llm — agentic coder (pi-style read/write/edit/bash core)");
  console.log("  llm 'task'                    agent loop");
  console.log("  llm --plain 'question'        single completion");
  console.log("  llm -m MODEL 'task'           pick a model");
  console.log("  llm --list                    list models (no key)");
  console.log("  llm --base URL 'task'         custom API base (local models)");
  console.log("  llm -s N 'task'               max agent steps (default 25)");
  console.log("Key: $LLM_API_KEY or " + CONFIG);
}

var model = DEFAULT_MODEL;
var base = API;
var plain = false;
var steps = 25;
var showList = false;
var rest = [];
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === "-m" || a === "--model") model = args[++i] || DEFAULT_MODEL;
  else if (a === "--base" || a === "--api") base = args[++i] || API;
  else if (a === "--plain" || a === "-p") plain = true;
  else if (a === "-s" || a === "--steps") { i++; steps = parseInt(args[i], 10); if (!(steps > 0)) { console.log("llm: invalid steps '" + args[i] + "'"); return 2; } }
  else if (a === "--list") showList = true;
  else if (a === "-h" || a === "--help") { usage(); return 0; }
  else rest.push(a);
}

async function getKey() {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  try {
    var k = await fs.read(CONFIG);
    var t = String(k).trim();
    if (t) return t;
  } catch {}
  return null;
}

if (showList) {
  try {
    var lresp = await fetch(base + "/models");
    var ldata = await lresp.json();
    var names = (ldata.data || []).map(function (m) { return m.id; }).sort();
    console.log((ldata.data || []).length + " models available:");
    console.log(names.join(NL));
  } catch (e) {
    console.log("llm: " + (e && e.message ? e.message : String(e)));
    return 1;
  }
  return 0;
}

var prompt = rest.join(" ");
if (!prompt) { usage(); return 2; }

var key = await getKey();
if (!key) {
  console.log("llm: no API key. Set $LLM_API_KEY or write it to " + CONFIG);
  console.log("(get one at https://openrouter.ai/keys — browser keys are for personal use)");
  return 1;
}

async function chat(messages, tools) {
  var body = { model: model, messages: messages };
  if (tools) body.tools = tools;
  var r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify(body),
  });
  var j = await r.json();
  if (!r.ok) {
    throw new Error(j && j.error && j.error.message ? j.error.message : "HTTP " + r.status);
  }
  return j;
}

async function runTool(tc) {
  var args = {};
  try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) {}
  var name = tc.function.name;
  var err = function (e) { return "ERROR: " + (e && e.message ? e.message : String(e)); };
  if (name === "read") {
    try { return String(await fs.read(args.path)).slice(0, 8000); }
    catch (e) { return err(e); }
  }
  if (name === "write") {
    try {
      await fs.write(args.path, args.content || "");
      return "OK: wrote " + args.path + " (" + String(args.content || "").length + " chars)";
    } catch (e) { return err(e); }
  }
  if (name === "edit") {
    try {
      var content = await fs.read(args.path);
      if (args.oldText && content.includes(args.oldText)) {
        await fs.write(args.path, content.split(args.oldText).join(args.newText || ""));
        return "OK: edited " + args.path;
      }
      return "ERROR: oldText not found in " + args.path;
    } catch (e) { return err(e); }
  }
  if (name === "bash") {
    try {
      var res = await shell.runLine(args.command || "");
      var out = ((res && res.out) ? res.out : "") + ((res && res.err) ? res.err : "");
      return "exit " + ((res && res.code !== undefined) ? res.code : 0) + NL + out.slice(0, 6000);
    } catch (e) { return err(e); }
  }
  return "ERROR: unknown tool " + name;
}

var messages = [
  { role: "system", content: AGENT_PROMPT },
  { role: "user", content: prompt },
];

if (plain) {
  var pj = await chat(messages, null);
  console.log((pj.choices && pj.choices[0] && pj.choices[0].message && pj.choices[0].message.content) || "(empty response)");
  return 0;
}

for (var step = 0; step < steps; step++) {
  var j = await chat(messages, TOOLS);
  var msg = j.choices && j.choices[0] && j.choices[0].message;
  if (!msg) { console.log("llm: empty response"); return 1; }
  var tcs = msg.tool_calls || [];
  if (tcs.length === 0) {
    console.log(msg.content || "(empty response)");
    return 0;
  }
  messages.push({ role: "assistant", content: msg.content || "", tool_calls: tcs });
  for (var t = 0; t < tcs.length; t++) {
    var tc = tcs[t];
    var fn = tc.function || {};
    console.log("  [" + (fn.name || "tool") + "] " + (fn.arguments || ""));
    var result = await runTool(tc);
    messages.push({ role: "tool", tool_call_id: tc.id || ("call_" + step + "_" + t), content: result });
  }
}
console.log("llm: reached the step limit (" + steps + ") without a final answer");
return 1;
