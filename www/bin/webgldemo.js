// webgldemo — bouncing colored triangle via /dev/webgl (browser only)
const vertex = `attribute vec2 aPosition;
uniform vec2 uOffset;
uniform vec2 uScale;
void main() {
  vec2 pos = aPosition * uScale + uOffset;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;
const fragment = `uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
}`;
try {
  await fs.write("/dev/webgl/shader/vertex", vertex);
  await fs.write("/dev/webgl/shader/fragment", fragment);
  await fs.write("/dev/webgl/buffer/aPosition", "f32 -1 -1 1 -1 0 1");
  await fs.write("/dev/webgl/clearcolor", "0.05 0.15 0.05 1");
  await fs.write("/dev/webgl/uniform/2f/uScale", "0.6 0.6");
  for (let i = 0; i < 60; i++) {
    const t = i / 60;
    const off = (Math.sin(t * 6) * 0.5).toFixed(3) + " " + (Math.cos(t * 6) * 0.3).toFixed(3);
    const r = (0.5 + 0.5 * Math.sin(t * 6)).toFixed(3);
    const g = (0.5 + 0.5 * Math.sin(t * 6 + 2)).toFixed(3);
    const b = (0.5 + 0.5 * Math.sin(t * 6 + 4)).toFixed(3);
    await fs.write("/dev/webgl/uniform/2f/uOffset", off);
    await fs.write("/dev/webgl/uniform/3f/uColor", r + " " + g + " " + b);
    await fs.write("/dev/webgl/call", "clear");
    await fs.write("/dev/webgl/call", "draw arrays triangles 3 0");
    await fs.write("/dev/webgl/call", "swap");
    await new Promise((res) => setTimeout(res, 100));
  }
  console.log("webgldemo: drew 60 frames — see the canvas at the bottom-right.");
  console.log("Try: cat /dev/webgl/state · cat /dev/webgl/log · cp /dev/webgl/frame /tmp/shot.png");
} catch (e) {
  console.log("webgldemo: " + e.message);
  return 1;
}
