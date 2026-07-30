// ─── Example: counter.js ────────────────────────────────────────
// A "binary" that demonstrates state persistence in the filesystem.
//
// Each invocation reads, increments, and writes a counter file.
// The counter persists because it lives in the virtual filesystem.

const counterPath = "/tmp/counter.txt";

let count;
try {
  const raw = await fs.read(counterPath);
  count = parseInt(raw.trim(), 10) || 0;
} catch {
  count = 0;
}

count++;
await fs.write(counterPath, String(count));
console.log(`Invocation #${count}`);
console.log(`Counter stored at: ${counterPath}`);
