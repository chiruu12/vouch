#!/usr/bin/env bash
# Poll for the account cap lifting, cheaply.
#
# Bright Data recalculates zone limits every ~15 minutes, so the cap may lift
# without KYC. One request per 15 minutes against our own fixture: it is the
# cheapest target, it is the one the demo actually needs, and probing more often
# would spend the very quota we are waiting on.
#
# Exits 0 the moment a run returns real rows, so the caller is notified.
# Exits 2 after 8 hours of no recovery.
set -u
cd "$(dirname "$0")/.."

COLLECTOR=c_msx7z3xi2hs08ccwms
URL="https://arcadia-safety.vercel.app/"
LOG=runs/recovery.log
MAX=32          # 32 * 15min = 8h
INTERVAL=900

for i in $(seq 1 "$MAX"); do
  ts=$(date -u +%H:%M:%SZ)
  out=$(timeout 120 npx -p @brightdata/cli bdata scraper run "$COLLECTOR" "$URL" --sync 2>&1)

  if printf '%s' "$out" | grep -qi 'too many requests\|rate_limit\|allowed rate limits'; then
    echo "$ts attempt $i/$MAX: still capped" >> "$LOG"
  elif printf '%s' "$out" | grep -q '"ref"'; then
    rows=$(printf '%s' "$out" | grep -o '"ref"' | wc -l | tr -d ' ')
    echo "$ts attempt $i/$MAX: RECOVERED, $rows rows" >> "$LOG"
    printf '%s' "$out" > runs/recovery-proof.json
    exit 0
  else
    echo "$ts attempt $i/$MAX: unclear -> $(printf '%s' "$out" | tail -c 200 | tr '\n' ' ')" >> "$LOG"
  fi

  sleep "$INTERVAL"
done

echo "$(date -u +%H:%M:%SZ) gave up after ${MAX} attempts; KYC is the only path" >> "$LOG"
exit 2
