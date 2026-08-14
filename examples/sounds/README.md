# Sound effects as lists of ints, in bash

Experimental companions to `examples/mimecroft.sh`: each script
synthesises one game sound effect and prints it as a **list of signed
16-bit ints** — mono PCM samples at 22050 Hz, the exact format
`/dev/audio`'s WAV renderer produces (`src/fs/audiodev.js`
`renderWavDataUrl`). The DSP is the same discipline as the texture
generators: pure integer arithmetic, seeded LCG noise, no floats, no
`$RANDOM`, no `local`, no C-style `for` — so the synthesis core
transpiles through bash2js if it ever has to run in the browser shell.

```
sounds/
  sound-lib.sh       shared core: sine table, waveforms, envelopes,
                     noise, and the output writers (WAV / PCM / TSV /
                     ASCII scope / notes)
  sound-hit.sh       one shot hits a block that does NOT break — the
                     "tick", MATERIAL-dependent (stone/dirt/wood/gold/gem)
  sound-break.sh     a block is destroyed: crack + debris rattle + thud
  sound-thud.sh      hitting indestructible obsidian: dull heavy thud
  sound-shoot.sh     firing the type-checking ray: saw sweep "pew"
  sound-kill.sh      a MIME is sanitised: descending vibrato wail
  sound-damage.sh    the player is hurt: dissonant detuned saws + noise
  sound-treasure.sh  an OS artifact is recovered: C5-E5-G5-C6 fanfare
  sound-shatter.sh   shooting an artifact destroys it: crystal crack +
                     three detuned glass shards (the licence-strike
                     mistake sound)
  sound-walk.sh      a footstep: heel thump + toe scuff (mimecroft has
                     no step sound yet — this is the candidate)
  sound-mime.sh      a nearby MIME: throbbing 55 Hz saw drone (also new)
  make-sounds.sh     batch: all sounds as .wav (host bash) or .tsv
  audition-sounds.sh echo each sound's name, then play it immediately —
                     the A/B audition (falls back to ASCII scopes when
                     there's no sound device)
```

## Usage

```bash
# WAV on stdout (host bash) — pipe to a player or redirect to a file
bash sound-hit.sh > hit-stone.wav
bash sound-kill.sh > kill.wav
bash sound-thud.sh --seed 7 > thud-7.wav

# the list of ints, as text (works everywhere incl. the browser shell)
bash sound-hit.sh --tsv            # header + tab-separated ints
bash sound-hit.sh --material gold --tsv
bash make-sounds.sh --tsv /tmp     # all ten sounds

# ASCII oscilloscope + stats (no file I/O, no printf -v)
bash sound-walk.sh --preview
bash sound-mime.sh --preview

# the mimecroft.sh play() calls this sound stands for — the bridge to
# today's /dev/audio (which only speaks oscillator notes)
bash sound-treasure.sh --notes

# batch
bash make-sounds.sh                      # sound-*.wav in CWD (host bash)
bash make-sounds.sh --tsv /tmp           # sound-*.tsv (anywhere)
bash make-sounds.sh --seed 7             # one seed, all WAVs

# audition: echo each name, play it right after
bash audition-sounds.sh                  # hit, break, thud, shoot, kill,
                                         # damage, treasure, walk, mime
bash audition-sounds.sh --seed 7         # one seed for all licks
bash audition-sounds.sh --repeat 2       # each sound twice (A/B)
bash audition-sounds.sh --preview        # visual only (ASCII scopes)
```

Per-sound options: `--material NAME` (hit: stone|dirt|wood|gold|gem;
break: dirt|wood|gold|gem), `--seed N` everywhere (the noise/licks),
`SOUND_SEED=N` and `SAMPLE_RATE=N` env vars as well. Note the scripts
`source sound-lib.sh` (they are experiments — run them from
`examples/sounds/`; the texture generators inline their lib because
they must run in jtsh, these don't need to yet).

## The TSV format (the list of ints)

`--tsv` emits a header plus rows of 32 tab-separated ints
(trailing-tab + newline, same shape as the texture TSV files):

```
#sound<TAB>kill<TAB>22050<TAB>seed<TAB>20240812<TAB>samples<TAB>6615<TAB>
22478<TAB>-30155<TAB>…   ← signed 16-bit PCM samples, 32 per row
```

Each int is one sample: amplitude ∈ [-32768, 32767], 22050 samples =
1 second. Concatenate rows, pack as int16 little-endian, prepend the
44-byte RIFF header (the script's default WAV output does exactly
this) and you have a playable file.

## Wiring into mimecroft.sh

Two bridges — one live, one for development:

1. **`--notes` (development)** — the closest the current oscillator
   device can get, printed as ready-to-paste `play()` calls. E.g. the
   treasure fanfare is three `play` lines instead of one:

   ```bash
   # sound-treasure.sh --notes
   play "C5 0.10"
   play "E5 0.10"
   play "G5 0.15"
   ```

   And the new sounds map onto calls like:

   ```bash
   # footsteps (a move lands) — sound-walk.sh --notes
   play "A1 0.04"
   # a MIME is near — sound-mime.sh --notes (loop while in range)
   play "A1 0.40"
   ```

2. **`--tsv` + `/dev/audio/samples` (live)** — the game plays the real
   sounds. `mimecroft --sounds bash` (or the settings menu's
   SOUND MODE row) switches the backend: each in-game `play "C5 0.10"`
   note call is mapped to a sound name, the generator is run once
   through the real bash wasm (`/bin/bash /examples/sounds/sound-X.sh
   --tsv`), its TSV is cached in `/tmp/mimecroft-snd-<name>.tsv`, and
   every subsequent play cats the cache to `/dev/audio/samples` — the
   device parses the int16 list and plays it as an AudioBuffer
   (`src/fs/audiodev.js parseSamplesPayload`, the same int16/22050
   contract `renderWavDataUrl` uses). Multi-note licks (the treasure
   fanfare, the shatter) are ONE sound; the material-aware `hit`
   sound gets the block type so stone/dirt/wood/gold/gem each ring
   differently. The default is `--sounds notes` — plain oscillator
   blips. To audition a sound outside the game: render the WAV and
   play it with an `<audio>` element via the downloadfs/`/pc` mount —
   `cp /dev/audio/frame /pc/tone.wav` already works that way.

## How the sounds are made (the DSP)

- **Phase accumulator** in 1/65536-cycle units — a frequency is a
  phase increment `f * 65536 / 22050`, a sweep is a linear ramp of
  the increment, vibrato/tremolo is an LFO phase added into the
  increment or envelope. No floats anywhere.
- **Sine** is a 256-entry table (scale ±32767) with linear
  interpolation and an explicit ring wrap; square/saw/triangle are
  derived from the same phase so every waveform starts at zero
  amplitude (no clicks).
- **Noise** is the Park–Miller LCG stream — seeded, so the same seed
  gives the same crackle. The crack/impact licks and the walk scuff
  eat the LCG stream; the tones never touch it.
- **Envelopes**: sharp attack + exponential decay for percussive
  ticks (`env = env * D / 256` per sample), linear fade for
  sustained sweeps (an audible exponential at integer rates dies in
  ~2 ms — too clicky for a pew or a wail).

## Per-sound notes

| script | mimecroft event today | what it sounds like |
|---|---|---|
| hit | `damage_cell` tick `C3 0.05` | material ping (stone 1046, dirt 392, wood 523, gold 1568 + shimmer, gem 2093 Hz) |
| break | block destroyed `E3 0.06` | noise crack → debris rattle → 150→80 Hz falling thud |
| thud | obsidian `G2 0.10` | 2 ms impact + 100→65 Hz sweep + late 50 Hz sub-settle |
| shoot | miss `D2 0.06` | saw 400→1500 Hz over 95 ms |
| kill | mime death `G5 0.08` | saw 700→110 Hz wail with 7 Hz vibrato + noise gasp |
| damage | hurt `C3 0.15` | 220+233 Hz detuned saws sweeping down, noise bleeding in |
| treasure | fanfare `C5 E5 G5` | 4-note arpeggio with overlap + octave shimmer |
| shatter | shot treasure `C4 0.12` `E2 0.18` | 1 ms crack + three detuned glass shards (2350/2790/3520 Hz) + low body thump |
| walk | *(none — new)* | heel thump + toe scuff, seeded |
| mime | *(none — new)* | 55 Hz saw drone, 8 Hz tremolo, detuned 57 Hz beating |

The `--seed` variations are the design handle: try `bash sound-walk.sh
--seed 3` vs `--seed 9` for different "floor textures", and
`bash sound-hit.sh --material gold --preview` to see the metallic
partial in the scope before you hear it.
