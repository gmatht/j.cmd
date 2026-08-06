// xclip — clipboard access for the browser shell (like the Linux xclip).
//   echo hi | xclip          copy stdin to the clipboard (default)
//   xclip -i                 copy stdin to the clipboard
//   xclip -o                 print the clipboard to stdout
//   xclip -c                 clear the clipboard
//   xclip -selection clipboard|primary|secondary — accepted; one clipboard
var isBrowser = typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText;
var mode = "in";
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === "-o" || a === "--output") mode = "out";
  else if (a === "-i" || a === "--input") mode = "in";
  else if (a === "-c" || a === "--clear") mode = "clear";
  else if (a === "-selection" || a === "-s") i++;   // one clipboard — accept any
  else if (a === "-h" || a === "--help") {
    console.log("xclip — clipboard access (browser shell)");
    console.log("  echo hi | xclip        copy stdin to the clipboard");
    console.log("  xclip -i               copy stdin to the clipboard");
    console.log("  xclip -o               print the clipboard");
    console.log("  xclip -c               clear the clipboard");
    return 0;
  }
}
if (!isBrowser) {
  console.log("xclip: the browser clipboard is unavailable here (run in the web shell)");
  return 1;
}
if (mode === "out") {
  try {
    var text = await navigator.clipboard.readText();
    console.log(text);
  } catch (e) {
    console.log("xclip: clipboard read denied — allow clipboard-read: " + e.message);
    return 1;
  }
  return 0;
}
if (mode === "clear") {
  try {
    await navigator.clipboard.writeText("");
    console.log("xclip: clipboard cleared");
  } catch (e) { console.log("xclip: " + e.message); return 1; }
  return 0;
}
if (!stdin) {
  console.log("xclip: nothing to copy — pipe text in (echo hi | xclip)");
  return 1;
}
try {
  await navigator.clipboard.writeText(stdin);
  console.log("xclip: " + stdin.length + " chars copied to the clipboard");
} catch (e) {
  console.log("xclip: " + e.message);
  return 1;
}
return 0;
