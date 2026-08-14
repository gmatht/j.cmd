#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-lib.sh — shared core for the experimental mimecroft sound
# generators (sound-hit.sh / sound-thud.sh / sound-walk.sh / ...).
#
# Each script synthesises a short game sound effect as a LIST OF INTs —
# signed 16-bit PCM samples at 22050 Hz mono, the exact format
# /dev/audio's WAV renderer produces (src/fs/audiodev.js
# renderWavDataUrl), so a sample list from these scripts can be packed
# into the same kind of WAV and, one day, fed to a /dev/audio/samples
# device. Until that device exists, `--notes` prints the equivalent
# mimecroft.sh `play "A4 0.1"` oscillator calls — the immediate bridge.
#
# Everything is pure integer arithmetic: no floats, no `$RANDOM`, no
# `local`, no C-style for loops, no `$(( ... ))` inlined inside test
# brackets — the same language discipline as examples/mimecroft.sh and
# the texture generators, so the synthesis core also transpiles
# through bash2js if it ever needs to run in the browser shell.
#
# Oscillator model:
#   • phase accumulator in 1/65536-cycle units (PHASE_SCALE) — no floats
#   • a 256-entry sine table scaled to ±32767, linear-interpolated
#   • waveforms: sine / square / sawtooth / triangle, all derived from
#     the same phase (wave16) — so a sound is a table lookup + a
#     multiply, nothing else, and every waveform starts at 0 amplitude
#     (no clicks)
#   • Park–Miller LCG (`rand`) for noise / jitter — seeded, so the
#     same seed → the same sample list
#   • envelopes are linear-attack × exponential-decay in integer
#     scale: env ∈ [0, 256], env = env * DECAY / 256 per sample
#
# Outputs (each sound script parses its own flags):
#   default        WAV file on stdout (host bash — needs printf -v)
#   --pcm          raw signed 16-bit LE samples (no header)
#   --tsv          the list of ints as text — header + tab-separated
#                  rows of 32 samples, trailing-tab + newline, same
#                  shape as the texture --tsv files
#   --preview      ASCII oscilloscope (peak bars) + stats
#   --notes        the mimecroft.sh play() calls this sound maps to
#
# A sound script looks like:
#
#   NAME="hit"
#   DUR_MS=50
#   parse_sound_args "$@"          # sets DO_*, SEED, per-script flags
#   . ./sound-lib.sh               # DSP + writers
#   render_sample() { ... set samp (int16) ... }   # called per sample
#   sound_main
# ─────────────────────────────────────────────────────────────────────

# ─── configuration (defaults — scripts may override before sourcing) ─
SR=22050                 # sample rate — matches audiodev's WAV renderer
PHASE_SCALE=65536        # one oscillator cycle = 65536 phase units
ENV_SCALE=256            # envelope 0..256 (multiplied into the sample)
DO_TSV=0
DO_PCM=0
DO_PREVIEW=0
DO_NOTES=0
SEED=20240812
if [ "$SOUND_SEED" != "" ]; then SEED=$SOUND_SEED; fi
if [ "$SAMPLE_RATE" != "" ]; then SR=$SAMPLE_RATE; fi
# the LCG (rand/noise16) runs on the lowercase seed — seed it from
# the parsed SEED now, or every sound shares the same constant noise
seed=$SEED

# ─── sine table: round(32767 * sin(2πk/256)), k = 0..255 ────────────
SIN0=(0 804 1608 2410 3212 4011 4808 5602 6393 7179 7962 8739 9512 10278 11039 11793 12539 13279 14010 14732 15446 16151 16846 17530 18204 18868 19519 20159 20787 21403 22005 22594 23170 23731 24279 24811 25329 25832 26319 26790 27245 27683 28105 28510 28898 29268 29621 29956 30273 30571 30852 31113 31356 31580 31785 31971 32137 32285 32412 32521 32609 32678 32728 32757 32767 32757 32728 32678 32609 32521 32412 32285 32137 31971 31785 31580 31356 31113 30852 30571 30273 29956 29621 29268 28898 28510 28105 27683 27245 26790 26319 25832 25329 24811 24279 23731 23170 22594 22005 21403 20787 20159 19519 18868 18204 17530 16846 16151 15446 14732 14010 13279 12539 11793 11039 10278 9512 8739 7962 7179 6393 5602 4808 4011 3212 2410 1608 804 0 -804 -1608 -2410 -3212 -4011 -4808 -5602 -6393 -7179 -7962 -8739 -9512 -10278 -11039 -11793 -12539 -13279 -14010 -14732 -15446 -16151 -16846 -17530 -18204 -18868 -19519 -20159 -20787 -21403 -22005 -22594 -23170 -23731 -24279 -24811 -25329 -25832 -26319 -26790 -27245 -27683 -28105 -28510 -28898 -29268 -29621 -29956 -30273 -30571 -30852 -31113 -31356 -31580 -31785 -31971 -32137 -32285 -32412 -32521 -32609 -32678 -32728 -32757 -32767 -32757 -32728 -32678 -32609 -32521 -32412 -32285 -32137 -31971 -31785 -31580 -31356 -31113 -30852 -30571 -30273 -29956 -29621 -29268 -28898 -28510 -28105 -27683 -27245 -26790 -26319 -25832 -25329 -24811 -24279 -23731 -23170 -22594 -22005 -21403 -20787 -20159 -19519 -18868 -18204 -17530 -16846 -16151 -15446 -14732 -14010 -13279 -12539 -11793 -11039 -10278 -9512 -8739 -7962 -7179 -6393 -5602 -4808 -4011 -3212 -2410 -1608 -804)

# ─── pseudorandom core (Park–Miller LCG; result rv ∈ [0, rn_m)) ─────
rand() {
  rn_m=$1
  seed=$(( (seed * 48271) % 2147483647 ))
  rv=$(( seed % rn_m ))
}

# ─── fixed-point sine: sin16 PHASE → sv ∈ [-32767, 32767] ───────────
# table index = phase >> 8, linear interpolation with the low byte —
# one lookup + one lerp, cheap enough for per-sample use in bash. The
# wrap is explicit: index 255 lerps back into entry 0 (a sine table
# is a ring), so there is no glitch where the table ends.
sin16() {
  si_p=$1
  si_i=$(( si_p >> 8 ))
  si_f=$(( si_p & 255 ))
  si_j=$(( si_i + 1 ))
  if [ "$si_j" -ge 256 ]; then si_j=0; fi
  si_a=${SIN0[$si_i]}
  si_b=${SIN0[$si_j]}
  sv=$(( si_a + ( si_b - si_a ) * si_f / 256 ))
}

# ─── waveform shape from a phase ([-32767, 32767], all start at 0
#     amplitude at phase 0 → no clicks): wave16 PHASE WAVE → wv ──────
wave16() {
  wv_p=$1
  wv_w=$2
  if [ "$wv_w" = "square" ]; then
    if [ "$wv_p" -lt 32768 ]; then wv=32767; else wv=-32767; fi
  elif [ "$wv_w" = "saw" ]; then
    wv=$(( wv_p - 32768 ))
  elif [ "$wv_w" = "triangle" ]; then
    if [ "$wv_p" -lt 32768 ]; then wv_t=$wv_p; else wv_t=$(( 65536 - wv_p )); fi
    wv=$(( wv_t * 2 - 32768 ))
  else
    sin16 $wv_p
    wv=$sv
  fi
}

# ─── white noise sample [-32767, 32767] — consumes the LCG stream ───
noise16() {
  seed=$(( (seed * 48271) % 2147483647 ))
  nv=$(( ( (seed >> 15) & 65535 ) - 32768 ))
  if [ "$nv" -gt 32767 ]; then nv=32767; fi
}

# ─── phase increment for a frequency: inc16 = f * 65536 / SR ────────
inc_of() {
  io_f=$1
  inc16=$(( io_f * PHASE_SCALE / SR ))
}

# ─── exponential decay: env = env * DECAY / 256 (DECAY < 256) ───────
env_decay() {
  ed_env=$1
  ed_d=$2
  env=$(( ed_env * ed_d / ENV_SCALE ))
}

# ─── 16-bit exponential decay: env16 = env16 * D / 65536 — the
#     sound-accurate version. The 256-scale version loses 2/256 per
#     step at the top and then truncates to 0 in ~130 samples, which
#     is a ~6 ms linear ramp, not a decay; in 16-bit scale a
#     D/65536 ≈ 0.99+ factor keeps the exponential character (and a
#     usable tail) for tens of milliseconds. ──────────────────────────
env_decay16() {
  ed16_env=$1
  ed16_d=$2
  env16=$(( ed16_env * ed16_d / 65536 ))
}

# ─── linear fade: env = ENV_SCALE * REMAIN / TOTAL — the fade for
#     sustained sounds (sweeps/drones). Exponential decay at audible
#     rates (DECAY ≤ 255) dies in milliseconds; a linear ramp over the
#     last N samples is predictable and click-free. ───────────────────
env_fade() {
  ef_r=$1
  ef_t=$2
  env=$(( ENV_SCALE * ef_r / ef_t ))
}

# ─── common flag parsing — sets DO_TSV / DO_PCM / DO_PREVIEW /
#     DO_NOTES / SEED; leaves unknown args in ARG_EXTRA for the script
#     (per-sound flags like --material) ──────────────────────────────
parse_sound_args() {
  ARG_EXTRA=""
  pa_i=1
  while [ "$pa_i" -le "$#" ]; do
    eval "pa_a=\${$pa_i}"
    if [ "$pa_a" = "--tsv" ]; then DO_TSV=1
    elif [ "$pa_a" = "--pcm" ]; then DO_PCM=1
    elif [ "$pa_a" = "--preview" ]; then DO_PREVIEW=1
    elif [ "$pa_a" = "--notes" ]; then DO_NOTES=1
    elif [ "$pa_a" = "--seed" ]; then
      pa_j=$(( pa_i + 1 ))
      eval "pa_s=\${$pa_j}"
      if [ "$pa_s" != "" ]; then
        SEED=$pa_s
        seed=$pa_s   # re-seed the LCG: the lib already sourced with the default
      fi
      pa_i=$pa_j
    else
      ARG_EXTRA="$ARG_EXTRA $pa_a"
    fi
    pa_i=$(( pa_i + 1 ))
  done
}

# ─── output writers ─────────────────────────────────────────────────
# probe printf -v (host bash / real-bash wasm yes; transpiled sh2 no).
# Without it, the binary byte paths fall back to TSV with a note.
printf -v probe_ok 'x' 2>/dev/null > /dev/null

# wav/pcm byte accumulation — one int16 LE sample (samp already in
# -32768..32767): two octal \ooo escapes appended to `out`
pcm_bytes() {
  pb_v=$samp
  if [ "$pb_v" -lt 0 ]; then pb_v=$(( pb_v + 65536 )); fi
  pb_b0=$(( pb_v & 255 ))
  pb_b1=$(( ( pb_v >> 8 ) & 255 ))
  printf -v oc '%03o' "$pb_b0"
  out="$out\\$oc"
  printf -v oc '%03o' "$pb_b1"
  out="$out\\$oc"
}

# ─── the render loop + finish ───────────────────────────────────────
# The script sets NAME, DUR_MS, optionally NSAMP (default from DUR_MS)
# and defines render_sample() — reads nothing, sets `samp` (int16) and
# may advance its own phase/envelope globals. This loop calls it once
# per sample, clamps, and routes the sample to the active writer
# (preview accumulates per-column peaks, then finish() prints it).
sound_main() {
  if [ "$NSAMP" = "" ]; then NSAMP=$(( DUR_MS * SR / 1000 )); fi
  if [ "$DO_NOTES" -eq 1 ]; then
    notes_out
    return 0
  fi
  # no printf -v (transpiled shell) → the binary byte paths can't
  # run; fall back to the text TSV list of ints
  if [ "$DO_PREVIEW" -eq 0 ] && [ "$DO_TSV" -eq 0 ] && [ "$probe_ok" != "x" ]; then
    DO_TSV=1
  fi
  out=""
  tsv=""
  PREV_COLS=72
  PREV_H=8
  prev_cell=$(( ( NSAMP + PREV_COLS - 1 ) / PREV_COLS ))
  prev_peaks=""
  pcol=0
  pcell=0
  ppeak=0
  i=0
  while [ "$i" -lt "$NSAMP" ]; do
    render_sample
    if [ "$samp" -lt -32768 ]; then samp=-32768; fi
    if [ "$samp" -gt 32767 ]; then samp=32767; fi
    if [ "$DO_PREVIEW" -eq 1 ]; then
      if [ "$samp" -lt 0 ]; then pa_v=$(( 0 - samp )); else pa_v=$samp; fi
      if [ "$pa_v" -gt "$ppeak" ]; then ppeak=$pa_v; fi
      pcell=$(( pcell + 1 ))
      if [ "$pcell" -ge "$prev_cell" ]; then
        prev_peaks="$prev_peaks $ppeak"
        ppeak=0
        pcell=0
      fi
    elif [ "$DO_TSV" -eq 1 ]; then
      tsv="$tsv$samp\t"
      pcol=$(( pcol + 1 ))
      if [ "$pcol" -ge 32 ]; then tsv="$tsv\n"; pcol=0; fi
    elif [ "$probe_ok" = "x" ]; then
      pcm_bytes
    fi
    i=$(( i + 1 ))
  done
  if [ "$DO_PREVIEW" -eq 1 ]; then
    preview_out
  elif [ "$DO_TSV" -eq 1 ]; then
    if [ "$pcol" -ne 0 ]; then tsv="$tsv\n"; fi
    echo "#sound	$NAME	$SR	seed	$SEED	samples	$NSAMP	"
    printf "%b" "$tsv"
  elif [ "$probe_ok" = "x" ]; then
    if [ "$DO_PCM" -eq 1 ]; then
      printf "%b" "$out"
    else
      # 44-byte RIFF/WAVE header, mono 16-bit PCM (same layout as
      # audiodev renderWavDataUrl) then the samples
      data_size=$(( NSAMP * 2 ))
      byte_rate=$(( SR * 2 ))
      hdr="\\x52\\x49\\x46\\x46"
      hb=$(( 36 + data_size ))
      printf -v oc '%03o' $(( hb & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( ( hb >> 8 ) & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( ( hb >> 16 ) & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( ( hb >> 24 ) & 255 )); hdr="$hdr\\$oc"
      hdr="$hdr\\x57\\x41\\x56\\x45\\x66\\x6d\\x74\\x20"
      printf -v oc '%03o' 16; hdr="$hdr\\$oc"
      printf -v oc '%03o' 0; hdr="$hdr\\$oc\\$oc\\$oc"
      printf -v oc '%03o' 1; hdr="$hdr\\$oc"
      printf -v oc '%03o' 0; hdr="$hdr\\$oc"
      printf -v oc '%03o' 1; hdr="$hdr\\$oc"
      printf -v oc '%03o' 0; hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( SR & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( ( SR >> 8 ) & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' 0; hdr="$hdr\\$oc\\$oc"
      printf -v oc '%03o' $(( byte_rate & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( ( byte_rate >> 8 ) & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' 0; hdr="$hdr\\$oc\\$oc"
      printf -v oc '%03o' 2; hdr="$hdr\\$oc"
      printf -v oc '%03o' 0; hdr="$hdr\\$oc"
      printf -v oc '%03o' 16; hdr="$hdr\\$oc"
      printf -v oc '%03o' 0; hdr="$hdr\\$oc"
      hdr="$hdr\\x64\\x61\\x74\\x61"
      printf -v oc '%03o' $(( data_size & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( ( data_size >> 8 ) & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( ( data_size >> 16 ) & 255 )); hdr="$hdr\\$oc"
      printf -v oc '%03o' $(( ( data_size >> 24 ) & 255 )); hdr="$hdr\\$oc"
      printf "%b" "$hdr$out"
    fi
  fi
}

# ─── ASCII oscilloscope: PREV_COLS peak columns, PREV_H rows tall ───
preview_out() {
  echo "sound: $NAME   dur: $(( NSAMP * 1000 / SR )) ms   samples: $NSAMP   seed: $SEED"
  echo "rate: $SR Hz  mono  int16  (each column = $prev_cell samples, peak |amplitude|)"
  # `prev_peaks` is a space-prefixed string " p0 p1 p2 …"; the n-th
  # column is the n-th word. Strip n words, read the next, done.
  po_c=0
  while [ "$po_c" -lt "$PREV_COLS" ]; do
    po_ps=" $prev_peaks "
    po_n=$po_c
    while [ "$po_n" -gt 0 ]; do
      po_ps=${po_ps#* }
      po_n=$(( po_n - 1 ))
    done
    po_pk=${po_ps%% *}
    if [ "$po_pk" = "" ]; then po_pk=0; fi
    eval "po_row_$po_c=\$po_pk"
    po_c=$(( po_c + 1 ))
  done
  # draw PREV_H rows from the top: a column's bar is `#` for every
  # row whose threshold the column peak clears
  po_i=0
  while [ "$po_i" -lt "$PREV_H" ]; do
    po_row=""
    po_c=0
    while [ "$po_c" -lt "$PREV_COLS" ]; do
      eval "po_pk=\$po_row_$po_c"
      po_thr=$(( ( PREV_H - po_i ) * 32767 / PREV_H ))
      if [ "$po_pk" -ge "$po_thr" ]; then po_row="$po_row#"; else po_row="$po_row "; fi
      po_c=$(( po_c + 1 ))
    done
    echo "$po_row"
    po_i=$(( po_i + 1 ))
  done
  # overall peak %
  po_max=0
  po_c=0
  while [ "$po_c" -lt "$PREV_COLS" ]; do
    eval "po_pk=\$po_row_$po_c"
    if [ "$po_pk" -gt "$po_max" ]; then po_max=$po_pk; fi
    po_c=$(( po_c + 1 ))
  done
  echo "peak: $(( po_max * 100 / 32767 ))%"
}

# ─── --notes: the mimecroft.sh play() sequence this sound stands for.
#     Scripts set NOTE_SEQ to "A4 0.1|C#5 0.08|..." lines (one per
#     oscillator blip) — printed as mimecroft `play "…"` calls with a
#     wav-vs-notes caveat. Default: a single sine note from NOTE_FREQ.
notes_out() {
  if [ "$NOTE_SEQ" != "" ]; then
    echo "# mimecroft.sh equivalent for sound '$NAME' — a sample-accurate"
    echo "# wav needs a /dev/audio/samples device; these oscillator notes"
    echo "# are the closest the current /dev/audio can get."
    no_s=$NOTE_SEQ
    while [ "$no_s" != "" ]; do
      no_n=${no_s%%|*}
      echo "play \"$no_n\""
      if [ "$no_s" = "$no_n" ]; then no_s=""; else no_s=${no_s#*|}; fi
    done
  else
    echo "play \"$NOTE_FREQ 0.1\""
  fi
}
