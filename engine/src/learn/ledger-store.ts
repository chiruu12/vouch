// Where the phrase ledger lives.
//
// Kept apart from the learner on purpose. gone-markers.ts is pure: give it a ledger and
// a page, get a ledger back, which is what lets a test drive a whole probe history
// without touching a disk. This module is the only thing that knows the file exists, so
// the learner can be reasoned about without reasoning about filesystems, and the path
// can move without touching the learning.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { emptyLedger, observePage, type PhraseLedger, type Verdict } from "./gone-markers.js";
import { disprovedMarkers, loadMarkers, retract, saveMarkers, type Retraction } from "./markers.js";

const PATH = new URL("../../learned/gone-candidates.json", import.meta.url).pathname;

export function loadLedger(): PhraseLedger {
  if (!existsSync(PATH)) return emptyLedger();
  try {
    return JSON.parse(readFileSync(PATH, "utf8")) as PhraseLedger;
  } catch {
    // A corrupt ledger is not worth failing a supervision cycle over. It holds counts
    // that rebuild themselves on the next probe, and nothing downstream is allowed to
    // act on it unattended anyway.
    return emptyLedger();
  }
}

export function saveLedger(ledger: PhraseLedger): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(ledger, null, 2) + "\n");
}

/** Collects pages during a cycle and writes once at the end.
 *
 *  `unresolved` is dropped rather than recorded. A page we were refused tells us nothing
 *  about what removal looks like on that site, and counting it either way would poison
 *  the one signal this ledger carries. */
export function pageCollector(source: string): {
  observe: (page: { ref: string; body: string; verdict: "gone" | "live" | "unresolved" }) => void;
  flush: () => Retraction[];
} {
  let ledger = loadLedger();
  let touched = 0;
  return {
    observe: (page) => {
      if (page.verdict === "unresolved") return;
      if (page.body === "") return;
      ledger = observePage(ledger, source, page.ref, page.body, page.verdict as Verdict);
      touched++;
    },
    flush: () => {
      if (touched > 0) saveLedger(ledger);
      return retractDisproved(source, ledger);
    },
  };
}

/** Take back any learned phrase this cycle's pages disproved.
 *
 *  This is the half of self-evolution that runs without asking. Adding a withdrawal
 *  phrase needs a person because a wrong one removes live safety recalls from the feed.
 *  Removing one is safe in exactly the way adding is not: the worst case is a withdrawn
 *  record lingering until somebody notices, which the rest of the system already handles
 *  by refusing to heal it. So the supervisor is allowed to narrow its own oracle on
 *  evidence, and never to widen it. */
export function retractDisproved(source: string, ledger: PhraseLedger): Retraction[] {
  let store = loadMarkers();
  const found = disprovedMarkers(store, ledger);
  if (found.length === 0) return [];
  const now = new Date().toISOString();
  for (const r of found) store = retract(store, r, source, now);
  saveMarkers(store);
  return found;
}
