// mail v2 — compose email via mailto: in a new tab (browser) or printed URL (CLI).
// v2: the first-use provider picker is a dropdown, not a text prompt.
//
//   mail to@example.com
//   mail to@example.com -s "Subject" -b "Body"
//   mail a@x.com b@y.com -s "Hi" -b "..."        multiple recipients
//   mail --provider proton to@example.com        one-shot provider
//   mail --set gmail                             change default provider
//   mail                                         show provider + usage
//
// First use shows a dropdown asking which provider should open the
// compose window (gmail / outlook / proton / fastmail / yahoo / default)
// and stores the choice in ~/.config/mail.provider.
//
// NOTE: no backslashes, backticks or dollar-brace sequences in this
// file — the shell embeds it verbatim in a template literal at boot,
// so any escape sequence would be mangled.

var NL = String.fromCharCode(10);
var CONFIG = ((env.HOME || "/home").replace(RegExp("/+$"), "") || "/") + "/.config/mail.provider";
var isBrowser = typeof window !== "undefined";

// Compose-window URL builders. "default" opens the bare mailto: URL and
// lets the OS/browser mail handler deal with it.
var PROVIDERS = {
  gmail:    function (m) { return "https://mail.google.com/mail/?extsrc=mailto&url=" + encodeURIComponent(m); },
  outlook:  function (m) { return "https://outlook.live.com/mail/0/deeplink/compose?" + mailQuery(m); },
  proton:   function (m) { return "https://mail.proton.me/u/0/compose?" + mailQuery(m); },
  fastmail: function (m) { return "https://app.fastmail.com/compose/?" + mailQuery(m); },
  yahoo:    function (m) { return "https://compose.mail.yahoo.com/?" + mailQuery(m); },
  default:  function (m) { return m; },
};
var KNOWN = Object.keys(PROVIDERS);

// mailto:to?subject=..&body=.. → to/subject/body params for webmail
// compose endpoints (they don't understand mailto: themselves).
function mailQuery(mailto) {
  var sep = mailto.indexOf("?");
  var to = sep === -1 ? mailto.slice(7) : mailto.slice(7, sep);
  var params = new URLSearchParams(sep === -1 ? "" : mailto.slice(sep + 1));
  var q = new URLSearchParams();
  if (to) q.set("to", to);
  if (params.get("subject")) q.set("subject", params.get("subject"));
  if (params.get("body")) q.set("body", params.get("body"));
  return q.toString();
}

async function readProvider() {
  try {
    var raw = await fs.read(CONFIG);
    return raw.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

function normalize(name) {
  var p = String(name || "").trim().toLowerCase();
  return KNOWN.includes(p) ? p : null;
}

function usage() {
  console.log("mail — compose email via mailto: in a new tab");
  console.log("  mail to@example.com");
  console.log('  mail to@example.com -s "Subject" -b "Body"');
  console.log('  mail a@x.com b@y.com -s "Hi" -b "..."   multiple recipients');
  console.log("  mail --provider proton to@example.com   one-shot provider");
  console.log("  mail --set gmail                        change default provider");
  console.log("  mail                                    show provider + usage");
  console.log("Providers: " + KNOWN.join(", "));
  console.log("Config: " + CONFIG);
}

// Dropdown provider picker (browser only) — a small modal with a <select>,
// because six known providers don't deserve a free-text prompt.
function pickProvider() {
  return new Promise(function (resolve) {
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:100;";
    var box = document.createElement("div");
    box.style.cssText = "background:#161b22;color:#e0e0e0;border:1px solid #30363d;border-radius:8px;padding:18px 22px;font-family:monospace;min-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.5);";
    var title = document.createElement("div");
    title.textContent = "Default mail provider";
    title.style.cssText = "font-weight:bold;margin-bottom:6px;";
    var sub = document.createElement("div");
    sub.textContent = "Where should mail compose open?" + NL + "Stored in " + CONFIG + NL + "Change anytime with: mail --set <provider>";
    sub.style.cssText = "color:#8b949e;font-size:12px;margin-bottom:12px;line-height:1.5;";
    var select = document.createElement("select");
    select.className = "mail-provider-select";
    select.style.cssText = "width:100%;padding:7px;margin-bottom:12px;background:#0d1117;color:#e0e0e0;border:1px solid #30363d;border-radius:4px;";
    KNOWN.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      select.appendChild(opt);
    });
    select.value = "gmail";
    var row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    var ok = document.createElement("button");
    ok.textContent = "Set provider";
    ok.style.cssText = "background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:7px 16px;cursor:pointer;";
    var cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;padding:7px 14px;cursor:pointer;";
    row.appendChild(ok);
    row.appendChild(cancel);
    box.appendChild(title);
    box.appendChild(sub);
    box.appendChild(select);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close(val) {
      overlay.remove();
      var hi = document.getElementById("hidden-input");
      if (hi) hi.focus();  // hand the keyboard back to the shell
      resolve(val);
    }
    ok.onclick = function () { close(select.value); };
    cancel.onclick = function () { close(null); };
    overlay.onclick = function (e) { if (e.target === overlay) close(null); };
    overlay.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); close(select.value); }
      else if (e.key === "Escape") { e.preventDefault(); close(null); }
    });
    select.focus();
  });
}

// Fallback if the DOM modal ever fails — plain prompt.
function fallbackPrompt() {
  return window.prompt(
    "Default mail provider?" + NL + "  " + KNOWN.join(" / ") + NL + "(stored in " + CONFIG + ")",
    "gmail"
  );
}

// ─── parse args ───
var to = [];
var subject = "";
var body = "";
var providerOverride = null;
var setProvider = null;
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === "-s") subject = args[++i] || "";
  else if (a === "-b") body = args[++i] || "";
  else if (a === "--set") setProvider = args[++i] || "";
  else if (a === "--provider") providerOverride = args[++i] || "";
  else if (a === "-h" || a === "--help" || a === "help") { usage(); return 0; }
  else to.push(a);
}

// ─── --set: persist a provider and stop ───
if (setProvider) {
  var p = normalize(setProvider);
  if (!p) {
    console.log("mail: unknown provider '" + setProvider + "' — try one of: " + KNOWN.join(", "));
    return 1;
  }
  await fs.write(CONFIG, p + NL);
  console.log("mail: default provider set to " + p + " (stored in " + CONFIG + ")");
  return 0;
}

// bare mail (no recipients/subject/body) — show state, don't compose
if (to.length === 0 && !subject && !body) {
  var cur = await readProvider();
  if (cur) console.log("mail: default provider is " + cur + " (stored in " + CONFIG + ")");
  else console.log("mail: no default provider set — you'll be asked on first compose.");
  usage();
  return 0;
}

// ─── resolve provider (--provider wins; else config; else first-use picker) ───
var provider = providerOverride ? normalize(providerOverride) : await readProvider();

if (providerOverride && !provider) {
  console.log("mail: unknown provider '" + providerOverride + "' — try one of: " + KNOWN.join(", "));
  return 1;
}

if (!provider) {
  if (isBrowser) {
    var answer = null;
    try {
      answer = await pickProvider();
    } catch {
      answer = fallbackPrompt();
    }
    if (answer === null) {
      console.log("mail: cancelled — no provider set. Run: mail --set gmail");
      return 1;
    }
    provider = normalize(answer) || "default";
    await fs.write(CONFIG, provider + NL);
    console.log("mail: default provider is " + provider + " (stored in " + CONFIG + ")");
  } else {
    console.log("mail: no default provider set. Run: mail --set gmail   (or outlook/proton/fastmail/yahoo/default)");
    return 1;
  }
}

// ─── build the mailto: and the compose URL ───
var mailto = "mailto:" + to.join(",");
var params = new URLSearchParams();
if (subject) params.set("subject", subject);
if (body) params.set("body", body);
var qs = params.toString();
if (qs) mailto += "?" + qs;

var url = PROVIDERS[provider](mailto);
var who = to.join(", ") || "(no recipients)";

if (isBrowser) {
  var win = window.open(url, "_blank");
  if (win) {
    console.log("mail: opening " + provider + " compose window for " + who);
  } else {
    console.log("mail: popup blocked — open this URL manually:");
    console.log(url);
  }
} else {
  console.log("mail: " + who + " via " + provider);
  console.log(url);
  console.log("(open the URL in a browser to compose)");
}
return 0;
