const counterPath = "/tmp/counter.txt";
let count;
try {
  const raw = await fs.read(counterPath);
  count = parseInt(raw.trim(), 10) || 0;
} catch { count = 0; }
count++;
await fs.write(counterPath, String(count));
console.log("Invocation #" + count);
