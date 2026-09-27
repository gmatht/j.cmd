/* fbrefr — the real-bash side of the fb0 device, as a REPLAYER.
 *
 * The shell script logs its fb_* calls to a command file and calls
 * `fbrefr <cmdfile> <out.ppm>`; this replays the log and dumps the
 * final frame. So:
 *
 *   real bash + this shim       -> the frame REAL BASH asks for
 *   bash-O4   + the same script -> the frame the TRANSPILER asks for
 *
 * and diffing the two images answers "did the transpiler change the
 * game?" without trusting the transpiler at all.
 *
 * Replaying the whole log is deliberate: no pipes, no co-process, no
 * synchronisation. A co-process tied to the script's stdout died with
 * it (every frame came out empty); a FIFO deadlocked on the open/reader
 * race.
 *
 * RECORDS end at a line holding only %%, not at a newline: a `blocks`
 * payload is MULTI-LINE (one cube per line), so a line-oriented log
 * would split a single draw call into dozens of bogus commands.
 *
 * NOTHING here goes through strtok on the whole record. strtok
 * replaces each delimiter with a NUL, so the payload's newlines became
 * terminators and only the first cube survived — the reference frame
 * came out black. The opcode is read by scanning to the first space;
 * the argument is read with strtod/strtoul on a bounded copy, and the
 * blocks payload is passed through untouched.
 */
#define _GNU_SOURCE
#include "fbdev.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* First whitespace-delimited token of `s`, as a fresh C string. */
static char *tok(const char **s) {
    const char *p = *s;
    const char *b;
    char *out;
    while (*p == ' ' || *p == '\t') p++;
    b = p;
    while (*p && *p != ' ' && *p != '\t' && *p != '\n') p++;
    out = (char *)malloc((size_t)(p - b) + 1);
    if (!out) return NULL;
    memcpy(out, b, (size_t)(p - b));
    out[p - b] = 0;
    *s = p;
    return out;
}

static void run(char *record) {
    const char *p = record;
    char *op;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == 0) return;
    op = tok(&p);
    if (!op) return;

    if (!strcmp(op, "open")) {
        char *w = tok(&p), *h = tok(&p);
        if (w && h) fb_open(atoi(w), atoi(h));
    } else if (!strcmp(op, "clear")) {
        char *c = tok(&p);
        if (c) fb_clear((uint32_t)strtoul(c, 0, 10));
    } else if (!strcmp(op, "cam")) {
        double v[5];
        int i;
        for (i = 0; i < 5; i++) {
            char *t = tok(&p);
            v[i] = t ? atof(t) : 0.0;
            free(t);
        }
        fb_set_camera(v[0], v[1], v[2], v[3], v[4]);
    } else if (!strcmp(op, "present")) {
        fb_present();
    } else if (!strcmp(op, "blocks")) {
        /* the payload is the REST of the record, VERBATIM: spaces and
         * newlines included, so it must not be tokenised at all */
        while (*p == ' ' || *p == '\t') p++;
        fb_blocks(p);
    }
    free(op);
}

int main(int argc, char **argv) {
    FILE *f;
    char *line = NULL, *rec = NULL;
    size_t cap = 0, reccap = 0, reclen = 0;
    ssize_t n;
    int have = 0;
    if (argc < 2) {
        fprintf(stderr, "fbrefr <cmdfile> [out.ppm]\n");
        return 2;
    }
    f = fopen(argv[1], "r");
    if (!f) {
        fprintf(stderr, "fbrefr: cannot open %s\n", argv[1]);
        return 1;
    }
    while ((n = getline(&line, &cap, f)) > 0) {
        /* A record terminator is a line holding exactly "%%". It
         * arrives as "%%\n", so the test is on the two bytes BEFORE
         * the newline — matching line[n-2]/line[n-1] against "%%"
         * misses every terminator and the whole log collapses into
         * one record. */
        if (n >= 3 && line[n - 2] == '%' && line[n - 3] == '%') {
            if (have) run(rec);
            reclen = 0;
            have = 0;
            continue;
        }
        if (reclen + (size_t)n + 1 > reccap) {
            reccap = (reclen + (size_t)n + 1) * 2;
            rec = (char *)realloc(rec, reccap);
            if (!rec) return 1;
        }
        memcpy(rec + reclen, line, (size_t)n);
        reclen += (size_t)n;
        rec[reclen] = 0;
        have = 1;
    }
    if (have) run(rec);
    free(rec);
    free(line);
    fclose(f);
    if (argc > 2) fb_dump_ppm(argv[2]);
    return 0;
}
