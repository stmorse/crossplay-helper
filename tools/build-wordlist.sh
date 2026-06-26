#!/usr/bin/env bash
# Regenerate assets/words.txt = the NYT Crossplay lexicon.
#
# Crossplay's word list is NWL2023 (NASPA Word List, 2023 ed., 196,601 entries)
# with exactly 182 words removed by NYT — almost all trademark-derived (KLEENEX,
# JACUZZI, …) plus ADRENALIN/ADRENALINS/ASBESTINE. Final list: 196,419 words.
# The 182 were reverse-engineered from the iOS app's SQLite DB by Brent Sleeper.
#
# Sources:
#   NWL2023:       github.com/scrabblewords/scrabblewords (words/North-American)
#   removed words: brentsleeper.com/.../crossplay-removed-words.txt
#
# NWL2023 is NASPA's copyrighted list; this script just reproduces the transform.
#
# Usage: tools/build-wordlist.sh   (run from the repo root)
set -euo pipefail

NWL_URL="https://raw.githubusercontent.com/scrabblewords/scrabblewords/master/words/North-American/NWL2023.txt"
REMOVED_URL="https://www.brentsleeper.com/uploads/2026/crossplay-removed-words.txt"
OUT="assets/words.txt"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading NWL2023…"
curl -fsSL "$NWL_URL" -o "$tmp/nwl.txt"
echo "Downloading removed-words list…"
curl -fsSL "$REMOVED_URL" -o "$tmp/removed.txt"

# NWL lines look like "WORD definition [n WORDS]"; keep the first token only.
awk '{print $1}' "$tmp/nwl.txt" | LC_ALL=C sort -u > "$tmp/words.txt"
tr -d '\r' < "$tmp/removed.txt" | awk 'NF{print toupper($1)}' | LC_ALL=C sort -u > "$tmp/removed_norm.txt"

# Remove the 182, keep only A-Z length 2-15, emit ASCII-sorted (DAWG needs sorted input).
LC_ALL=C comm -23 "$tmp/words.txt" "$tmp/removed_norm.txt" \
  | awk '{w=toupper($0)} w ~ /^[A-Z]{2,15}$/ {print w}' \
  | LC_ALL=C sort -u > "$OUT"

n="$(wc -l < "$OUT" | tr -d ' ')"
echo "Wrote $OUT — $n words (expected 196419)."
[ "$n" = "196419" ] || { echo "WARNING: count != 196419"; exit 1; }
