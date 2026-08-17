// Small text helpers shared by the query builder and the matcher.
//
// These live in their own file because both sides have to agree. When only the query
// builder singularised, it searched for "Cooluli Minifridge" while the matcher was
// still holding the token "minifridges", so the search found the right listings and
// the matcher then threw them away. A shared rule is the fix; two copies of a rule
// is the bug.

/** Words ending in s that are not plurals. Stripping these produces "ga" and "len",
 *  which match nothing. Short list on purpose: it only has to cover words that
 *  plausibly appear in a product name. */
const NOT_PLURAL = new Set([
  "gas", "lens", "bus", "glass", "brass", "press", "class", "dress", "cross",
  "axis", "series", "species", "hose", "case", "base",
]);

/** Singularise just enough that "Minifridges" and "mini fridge" meet in the middle.
 *  Crude on purpose: a real stemmer would be more accurate and is not worth the
 *  dependency. The length guard is what keeps three-letter words like "gas" intact. */
export function singular(tok: string): string {
  if (NOT_PLURAL.has(tok.toLowerCase())) return tok;
  if (tok.length < 4) return tok;
  // boxes -> box, dishes -> dish, churches -> church
  if (/(?:s|x|z|ch|sh)es$/i.test(tok)) return tok.slice(0, -2);
  // cubes -> cube, minifridges -> minifridge, washers -> washer, cans -> can
  if (/[^s]s$/i.test(tok)) return tok.slice(0, -1);
  return tok;
}

/** Accessory nouns. A power cable for a recalled fridge is not a recalled fridge, and
 *  a listing whose subject is the accessory must not be presented as the product.
 *  Discovered from real results: three of four early Cooluli "matches" were a power
 *  cable, a replacement cord and a branded eye mask. */
// Kept deliberately narrow. The first draft included "plug", "hose" and "wand", which
// quarantined "Cooluli Mini Fridge Plug In Cooler" and would quarantine any pressure
// washer sold "with hose and wand". Those are descriptions of the product, not
// accessories to it. A word only belongs here if a listing whose title contains it is
// almost never the product itself.
const ACCESSORY = new Set([
  "cable", "cord", "charger", "adapter", "adaptor", "sticker", "decal", "logo",
  "replacement", "spare", "bracket", "mount", "remote", "keychain",
]);

/** Does this look like a listing for an accessory rather than the product itself? */
export function mentionsAccessory(tokens: readonly string[]): string | null {
  for (const t of tokens) {
    if (ACCESSORY.has(t)) return t;
  }
  return null;
}
