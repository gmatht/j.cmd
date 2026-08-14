#!/bin/bash
# Wait out the GitHub Actions/Pages outage, then re-trigger the Pages
# deploy for the current main and verify it lands.
#
# Started 2026-08-06 while GitHub had a "Partial System Outage"
# (Actions + Pages major outage) that made hosted runners unavailable.
# Every 5 minutes: if the status API reports both Actions and Pages as
# operational AND the last workflow run failed/succeeded-without-our-
# commit, dispatch a fresh run and wait for it to complete.
set -u
cd /root/src/sh2runtime
LOG=/root/src/sh2runtime/ghpages-watch.log
WANT=$(git rev-parse main)

log() { echo "$(date -u +%H:%M:%S) $*" >> "$LOG"; }

log "watch started (want commit $WANT)"

for attempt in $(seq 1 720); do   # up to 60h
  # 1. Status page: Actions and Pages must both be operational.
  ok=$(timeout 30 curl -s "https://www.githubstatus.com/api/v2/components.json" 2>/dev/null \
    | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  comps={c['name']:c['status'] for c in d['components']}
  print('1' if comps.get('Actions')=='operational' and comps.get('Pages')=='operational' else '0')
except Exception: print('0')
" 2>/dev/null)
  if [ "$ok" != "1" ]; then
    log "still degraded (ok=$ok) — sleeping 5m"
    sleep 300; continue
  fi

  # 2. Dispatch a fresh run of the pages workflow.
  log "status OK — dispatching pages.yml"
  timeout 60 gh workflow run pages.yml --ref main >> "$LOG" 2>&1
  sleep 60

  # 3. Wait for the newest run to finish (up to 20 min).
  for w in $(seq 1 24); do
    st=$(timeout 30 curl -s "https://api.github.com/repos/gmatht/j.cmd/actions/runs?per_page=1" 2>/dev/null \
      | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)['workflow_runs'][0]
  print(d['head_sha'][:7], d['status'], d.get('conclusion'))
except Exception: print('? ? ?')
" 2>/dev/null)
    sha=$(echo $st | cut -d' ' -f1)
    status=$(echo $st | cut -d' ' -f2)
    conc=$(echo $st | cut -d' ' -f3)
    if [ "$status" = "completed" ]; then
      log "run done: $st"
      # Success AND it deployed our commit?
      if [ "$conc" = "success" ] && [ "$sha" = "${WANT:0:7}" ]; then
        # Verify the live site carries the new commit stamp.
        v=$(timeout 30 curl -s -m 25 "https://gmatht.github.io/j.cmd/www/version.txt" 2>/dev/null | head -1)
        if echo "$v" | grep -q "$WANT"; then
          log "DEPLOYED: gmatht.github.io now serves $WANT"
          exit 0
        fi
        log "run succeeded but version.txt still old ('$v') — will retry"
      fi
      break
    fi
    sleep 60
  done
  log "sleeping 5m before next attempt"
  sleep 300
done
log "gave up after 720 attempts"
exit 1
