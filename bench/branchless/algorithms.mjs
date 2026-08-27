// ─── bench/branchless/algorithms.mjs — the NAIVE branchy algorithms ──
//
// Each shader is written in the NAIVE form: data-dependent `while`/`if`
// conditions (the kind that cause warp divergence on a GPU). The branchless
// pre-passes in c-programs.mjs (lowerBranchless / selectIfElse) rewrite them
// automatically — this benchmark proves the optimisation is GENERAL, not a
// collatz-specific hack, by checking the auto-lowered shaders against a plain
// JS reference for several different branch patterns:
//
//   mandelbrot  — `while |z|² ≤ 4` escape test (data-dependent termination)
//   maxreduce   — `if v > max` per element (single-branch if in a for loop)
//   threshold   — `if v > 500` conditional count (single-branch if)
//   clamp       — `if v < 0` / `if v > 255` (two single-branch clamps)
//
// Each `shader(TW, P, BLOCK, basePixels)` is a block-reduction fragment
// program (one pixel per BLOCK items, like the gcc-vs-igpu harness) and each
// `reference(N, BLOCK)` is the exact same computation in JS.

export const ALGORITHMS = {
  mandelbrot: {
    name: "Mandelbrot escape (while |z|² ≤ 4)",
    maxIter: 64,
    shader(TW, P, BLOCK, basePixels = 0) {
      const blist = Array.from({ length: BLOCK }, (_, i) => i).join(" ");
      return [
        `p=$(( frag_y * ${TW} + frag_x + ${basePixels} ))`,
        `g0=$(( p * ${BLOCK} ))`,
        "sum=0",
        `if [ $p -lt ${P} ]; then`,
        "    for b in " + blist + "; do",
        "        g=$(( g0 + b ))",
        "        fx=$(( g % 64 ))",
        "        fy=$(( (g / 64) % 64 ))",
        "        cr=$(( (fx - 32) * 2 ))",
        "        ci=$(( (fy - 32) * 2 ))",
        "        zr=0",
        "        zi=0",
        "        iter=0",
        "        while [ $(( zr * zr + zi * zi )) -le 4 ]; do",
        "            zr_new=$(( zr * zr - zi * zi + cr ))",
        "            zi_new=$(( 2 * zr * zi + ci ))",
        "            zr=$(( zr_new ))",
        "            zi=$(( zi_new ))",
        "            iter=$(( iter + 1 ))",
        "        done",
        "        sum=$(( sum + iter ))",
        "    done",
        "fi",
        "putb $(( sum ))",
      ].join("\n");
    },
    reference(N) {
      let sum = 0;
      for (let g = 0; g < N; g++) {
        const fx = g % 64, fy = ((g / 64) | 0) % 64;
        const cr = (fx - 32) * 2, ci = (fy - 32) * 2;
        let zr = 0, zi = 0, iter = 0;
        while (zr * zr + zi * zi <= 4 && iter < 64) {
          const zrn = zr * zr - zi * zi + cr;
          const zin = 2 * zr * zi + ci;
          zr = zrn; zi = zin; iter++;
        }
        sum = (sum + iter) >>> 0;
      }
      return sum >>> 0;
    },
  },

  maxreduce: {
    name: "block max (if v > max)",
    shader(TW, P, BLOCK, basePixels = 0) {
      const blist = Array.from({ length: BLOCK }, (_, i) => i).join(" ");
      return [
        `p=$(( frag_y * ${TW} + frag_x + ${basePixels} ))`,
        `g0=$(( p * ${BLOCK} ))`,
        "max=0",
        `if [ $p -lt ${P} ]; then`,
        "    for b in " + blist + "; do",
        "        g=$(( g0 + b ))",
        "        v=$(( (g * 37 + 11) % 1000 ))",
        "        if [ $v -gt $max ]; then max=$v; fi",
        "    done",
        "fi",
        "putb $(( max ))",
      ].join("\n");
    },
    reference(N, BLOCK) {
      let sum = 0;
      for (let p = 0; p < N / BLOCK; p++) {
        let m = 0;
        for (let b = 0; b < BLOCK; b++) {
          const v = (p * BLOCK + b) * 37 + 11;
          const vm = v - 1000 * ((v / 1000) | 0);
          if (vm > m) m = vm;
        }
        sum = (sum + m) >>> 0;
      }
      return sum >>> 0;
    },
  },

  threshold: {
    name: "threshold count (if v > 500)",
    shader(TW, P, BLOCK, basePixels = 0) {
      const blist = Array.from({ length: BLOCK }, (_, i) => i).join(" ");
      return [
        `p=$(( frag_y * ${TW} + frag_x + ${basePixels} ))`,
        `g0=$(( p * ${BLOCK} ))`,
        "count=0",
        `if [ $p -lt ${P} ]; then`,
        "    for b in " + blist + "; do",
        "        g=$(( g0 + b ))",
        "        v=$(( (g * 53 + 7) % 1000 ))",
        "        if [ $v -gt 500 ]; then count=$(( count + 1 )); fi",
        "    done",
        "fi",
        "putb $(( count ))",
      ].join("\n");
    },
    reference(N, BLOCK) {
      let sum = 0;
      for (let p = 0; p < N / BLOCK; p++) {
        let c = 0;
        for (let b = 0; b < BLOCK; b++) {
          const g = p * BLOCK + b;
          const v = (g * 53 + 7) - 1000 * (((g * 53 + 7) / 1000) | 0);
          if (v > 500) c++;
        }
        sum = (sum + c) >>> 0;
      }
      return sum >>> 0;
    },
  },

  clamp: {
    name: "clamp to [0,255] (two ifs)",
    shader(TW, P, BLOCK, basePixels = 0) {
      const blist = Array.from({ length: BLOCK }, (_, i) => i).join(" ");
      return [
        `p=$(( frag_y * ${TW} + frag_x + ${basePixels} ))`,
        `g0=$(( p * ${BLOCK} ))`,
        "sum=0",
        `if [ $p -lt ${P} ]; then`,
        "    for b in " + blist + "; do",
        "        g=$(( g0 + b ))",
        "        v=$(( (g * 89 + 3) % 1000 - 500 ))",
        "        if [ $v -lt 0 ]; then v=0; fi",
        "        if [ $v -gt 255 ]; then v=255; fi",
        "        sum=$(( sum + v ))",
        "    done",
        "fi",
        "putb $(( sum ))",
      ].join("\n");
    },
    reference(N, BLOCK) {
      let sum = 0;
      for (let p = 0; p < N / BLOCK; p++) {
        for (let b = 0; b < BLOCK; b++) {
          const g = p * BLOCK + b;
          const v = (g * 89 + 3) - 1000 * (((g * 89 + 3) / 1000) | 0) - 500;
          const c = v < 0 ? 0 : v > 255 ? 255 : v;
          sum = (sum + c) >>> 0;
        }
      }
      return sum >>> 0;
    },
  },
};
