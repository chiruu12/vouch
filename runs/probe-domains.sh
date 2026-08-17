#!/usr/bin/env bash
# Which real sites can this account actually fetch before KYC?
#
# The rate-limit error on eBay is ambiguous: Bright Data returns the same message
# for volume limits and for domains that require Full Access. Seven requests
# cannot trip a 1000/min limit, so if some sites pass and others return the same
# error, the limit is per-domain and a permitted marketplace unblocks us today.
set -u

OUT=runs/domain-probe.tsv
: > "$OUT"

probe() {
  local label="$1" url="$2"
  local body rc
  body=$(timeout 90 npx -p @brightdata/cli bdata scrape "$url" 2>&1)
  rc=$?
  local verdict bytes
  bytes=$(printf '%s' "$body" | wc -c | tr -d ' ')
  if printf '%s' "$body" | grep -qi 'exceeded the allowed rate limits'; then
    verdict=RATE_LIMIT
  elif printf '%s' "$body" | grep -qi 'not allowed\|usage policy\|blocked by Bright Data'; then
    verdict=DOMAIN_DENIED
  elif [ "$rc" -ne 0 ]; then
    verdict=ERROR
  elif [ "$bytes" -lt 2000 ]; then
    verdict=THIN
  else
    verdict=OK
  fi
  printf '%s\t%s\t%s\t%s\n' "$verdict" "$bytes" "$label" "$url" | tee -a "$OUT"
  sleep 4
}

probe fixture-control "https://arcadia-safety.vercel.app/"
probe ebay-us         "https://www.ebay.com/sch/i.html?_nkw=pressure+washer"
probe walmart         "https://www.walmart.com/search?q=pressure+washer"
probe etsy            "https://www.etsy.com/search?q=space+heater"
probe mercari         "https://www.mercari.com/search/?keyword=space+heater"
probe aliexpress      "https://www.aliexpress.com/w/wholesale-pressure-washer.html"
probe reverb          "https://reverb.com/marketplace?query=amplifier"
probe bonanza         "https://www.bonanza.com/items/search?q%5Bsearch_term%5D=space+heater"

echo "=== done ==="
sort "$OUT"
