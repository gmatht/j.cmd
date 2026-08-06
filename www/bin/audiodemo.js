// audiodemo — play a tune via /dev/audio (browser only)
const notes = ["C4 0.25", "D4 0.25", "E4 0.25", "F4 0.25", "G4 0.25", "A4 0.25", "B4 0.25", "C5 0.5"];
try {
  await fs.write("/dev/audio/wave", "sine");
  await fs.write("/dev/audio/gain", "0.25");
  for (const n of notes) {
    await fs.write("/dev/audio/note", n);
    await new Promise((res) => setTimeout(res, 280));
  }
  await fs.write("/dev/audio/freq", "440");
  await fs.write("/dev/audio/on");
  await new Promise((res) => setTimeout(res, 1200));
  await fs.write("/dev/audio/off");
  console.log("audiodemo: played a C-major scale, then a 440Hz drone.");
  console.log("Try: echo 880 > /dev/audio/freq · echo square > /dev/audio/wave · echo A4 0.5 > /dev/audio/note");
  console.log("     cat /dev/audio/status · cp /dev/audio/frame /pc/tone.wav");
} catch (e) {
  console.log("audiodemo: " + e.message);
  return 1;
}
