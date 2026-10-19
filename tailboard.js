"use strict";

// IMPORTANT: the whole module is wrapped in an IIFE.
//
// The app loads these as classic <script> tags, which share ONE global lexical
// scope — so a top-level `const` here collides with the same name in
// recommend-drills.js and the second file dies with "Identifier 'API' has
// already been declared", silently, before defining anything. The Node tests
// cannot catch that: `require` gives every module its own scope, so they pass
// either way. It took loading the app in a browser to find it.
//
// Any future browser-loaded module in app/ should be wrapped the same way.
(function () {
"use strict";

// Tailboard — the personal reflection a firefighter writes after a call or a
// drill, and the rules for what it does to their recommendations.
//
// This is the "reflect" quarter of need -> train -> reflect -> improve. Without
// it the loop is open: the app says what to train and never learns whether it
// helped.
//
// Pure by design. No DOM, no storage, no clock of its own — the caller passes
// `now` so behavior is testable and does not drift with the machine clock.
//
// Design: products/drillground/docs/tailboard-design.md

const WENT = ["well", "ok", "rough"];
const KINDS = ["drill", "call"];

// A drill logged inside this window drops out of recommendations, so the app
// does not hand you the same drill two days running.
//
// This is NOT skill decay on a schedule we invented — self-assessment-design.md
// rules that out. It is a record of what actually happened, used only to avoid
// repetition.
const RECENCY_DAYS = 14;

const NOTE_MAX = 280;

// A rough reflection is evidence you might be weaker than you said; a good one
// is evidence you might be stronger. Both are only ever OFFERED to the user —
// see suggestRatingChange. Nothing here writes a rating.
const WEAKER = { solid: "rusty", rusty: "shaky", shaky: "untrained" };
const STRONGER = { untrained: "shaky", shaky: "rusty", rusty: "solid" };

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isString(v) {
  return typeof v === "string";
}

/**
 * Validate and normalise a reflection before it is stored.
 * Returns { ok, entry, errors } — never throws on bad input.
 */
function buildEntry(input, now) {
  const raw = isPlainObject(input) ? input : {};
  const errors = [];

  const kind = KINDS.indexOf(raw.kind) !== -1 ? raw.kind : null;
  if (!kind) errors.push("kind must be 'drill' or 'call'.");

  const went = WENT.indexOf(raw.went) !== -1 ? raw.went : null;
  if (!went) errors.push("went must be 'well', 'ok', or 'rough'.");

  const category = isString(raw.category) && raw.category.trim() ? raw.category.trim() : null;
  if (!category) errors.push("category is required — it is what ties a reflection to training.");

  // A drill reflection must name the drill; a call reflection must not invent one.
  const drillId = isString(raw.drillId) && raw.drillId.trim() ? raw.drillId.trim() : null;
  if (kind === "drill" && !drillId) errors.push("a drill reflection must name the drill.");

  let note = isString(raw.note) ? raw.note.trim() : "";
  if (note.length > NOTE_MAX) note = note.slice(0, NOTE_MAX);

  if (errors.length) return { ok: false, entry: null, errors };

  return {
    ok: true,
    errors: [],
    entry: {
      id: raw.id || "tb-" + new Date(now).getTime() + "-" + Math.floor((raw.seed || 0) % 100000),
      at: new Date(now).toISOString(),
      kind,
      drillId: kind === "drill" ? drillId : null,
      category,
      went,
      note,
    },
  };
}

/** Newest first. The history view and the recency check both rely on this. */
function addEntry(log, entry) {
  const entries = isPlainObject(log) && Array.isArray(log.entries) ? log.entries.slice() : [];
  entries.unshift(entry);
  return { version: 1, entries };
}

function removeEntry(log, id) {
  const entries = isPlainObject(log) && Array.isArray(log.entries) ? log.entries : [];
  return { version: 1, entries: entries.filter((e) => e && e.id !== id) };
}

/**
 * Drill ids logged within the recency window — the drills a user should not be
 * handed again just yet.
 */
function recentlyTrainedDrillIds(log, now, days) {
  const entries = isPlainObject(log) && Array.isArray(log.entries) ? log.entries : [];
  const windowDays = typeof days === "number" && days >= 0 ? days : RECENCY_DAYS;
  const cutoff = new Date(now).getTime() - windowDays * 24 * 60 * 60 * 1000;
  const ids = [];
  entries.forEach((e) => {
    if (!e || !e.drillId) return;
    const t = new Date(e.at).getTime();
    if (isNaN(t) || t < cutoff) return;
    if (ids.indexOf(e.drillId) === -1) ids.push(e.drillId);
  });
  return ids;
}

/**
 * What the app OFFERS to change after a reflection. Returns null when there is
 * nothing worth suggesting.
 *
 * Crucially this never returns a change to the category's weakness based on the
 * mere fact that a drill happened. Doing a mayday drill does not make you good
 * at mayday — if it did, the app would walk users away from their weakest areas
 * one drill at a time, which is the most damaging thing this feature could do.
 * Only how it FELT moves the needle, and only as a suggestion the user accepts.
 */
function suggestRatingChange(entry, currentRating) {
  if (!isPlainObject(entry)) return null;
  if (!isString(currentRating)) return null;

  if (entry.went === "rough") {
    const to = WEAKER[currentRating];
    return to ? { category: entry.category, from: currentRating, to, because: "rough" } : null;
  }
  if (entry.went === "well") {
    const to = STRONGER[currentRating];
    return to ? { category: entry.category, from: currentRating, to, because: "well" } : null;
  }
  return null; // "ok" is not evidence of anything
}

/** Human-readable prompt for the suggestion. The user must see the reasoning. */
function describeSuggestion(suggestion, categoryName) {
  if (!suggestion) return "";
  const label = categoryName || suggestion.category;
  const lead =
    suggestion.because === "rough"
      ? "That one was rough."
      : "That went well.";
  return lead + " Update " + label + " from " + suggestion.from + " to " + suggestion.to + "?";
}

const API = {
  buildEntry,
  addEntry,
  removeEntry,
  recentlyTrainedDrillIds,
  suggestRatingChange,
  describeSuggestion,
  WENT,
  KINDS,
  RECENCY_DAYS,
  NOTE_MAX,
};

// Loaded by the Node tests via require, and by the app as a plain script.
if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundTailboard = API;
}

})();
