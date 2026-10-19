"use strict";

// IMPORTANT: the whole module is wrapped in an IIFE.
//
// The app loads these as classic <script> tags, which share ONE global lexical
// scope — so a top-level `const` here would collide with the same name in
// another module and the second file would die silently before defining
// anything. recommend-drills.js, tailboard.js and entitlements.js are wrapped
// the same way; a regression test loads them all into one shared context. See
// tailboard.js for the full story.
(function () {
"use strict";

// Resource packs — the material a drill NAMES but does not SHIP. The card deck,
// the case study, the worksheet, the reference card, the image deck, the floor
// plan. See docs/resource-packs-design.md.
//
// Pure by design: no DOM, no fetch. The app does the fetching and hands the
// parsed files in; this module only decides what a pack means and what the user
// is allowed to see of it.
//
// THE POINT OF THE PACKS. Every drill is free — all 87. What is sold is the work
// of assembling what the drills tell you to build: a thirty-card mayday deck, a
// friction-loss key, a twenty-photo placard deck and its ERG answer key, a
// blind-timeline template. A firefighter who would rather build their own is
// welcome to, and the drill says how. A pack removes prep and never removes the
// drill.

// One Play unlock covers every support pack. Source packs may still carry
// resource_packs / promotion_prep_packs as authoring tags; gating ignores that
// split. Neither name can gate a drill.
var PAID_AREAS = ["support_packs"];
var DEFAULT_PAID_AREA = "support_packs";
var LEGACY_PAID_AREAS = ["resource_packs", "promotion_prep_packs"];

// Component kinds, in the order the app renders them. Reference material before
// the thing you practice with, and the case study before the worksheet you fill
// in from it — a user opening a pack should be able to read straight down.
var KIND_ORDER = [
  "reference_card",
  "case_study",
  "card_deck",
  "scenario_set",
  "image_deck",
  "floor_plan",
  "worksheet",
];

var KIND_LABELS = {
  card_deck: "Card deck",
  image_deck: "Image deck",
  case_study: "Case study",
  worksheet: "Worksheet",
  scenario_set: "Scenario set",
  reference_card: "Reference card",
  floor_plan: "Floor plan",
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Which entitlement gates this pack. Every paid pack is the one unlock. */
function packPaidArea(pack) {
  if (!isPlainObject(pack)) return DEFAULT_PAID_AREA;
  if (pack.paid_area === DEFAULT_PAID_AREA) return DEFAULT_PAID_AREA;
  if (LEGACY_PAID_AREAS.indexOf(pack.paid_area) !== -1) return DEFAULT_PAID_AREA;
  return DEFAULT_PAID_AREA;
}

// Callers pass a predicate rather than a boolean because a pack's gate depends on
// WHICH area it belongs to, and the app holds one entitlement map for both.
function entitledFn(isEntitled) {
  if (typeof isEntitled === "function") return isEntitled;
  // Tolerate a plain boolean so a caller with a single-area view still works.
  return function () {
    return !!isEntitled;
  };
}

/** Display label for a component kind. Unknown kinds degrade to the raw value. */
function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind || "");
}

/**
 * Index the published resource file by drill id.
 *
 * @param {object} published  parsed drill_resources.published.json
 * @returns {object} drillId -> pack (free packs whole, paid packs as previews)
 */
function indexPacks(published) {
  var out = {};
  var packs = (published && published.packs) || [];
  for (var i = 0; i < packs.length; i++) {
    var p = packs[i];
    if (isPlainObject(p) && typeof p.drill_id === "string") out[p.drill_id] = p;
  }
  return out;
}

/**
 * Fold the unlocked payload over the index, replacing previews with the real
 * packs. Called only after the entitlement is granted and the payload fetched.
 *
 * Returns a NEW index rather than mutating, so a failed or partial fetch cannot
 * leave the app holding half-upgraded state.
 *
 * @param {object} index     from indexPacks
 * @param {object} unlocked  parsed drill_resources.unlocked.json
 */
function applyUnlocked(index, unlocked) {
  var merged = {};
  var key;
  for (key in index) {
    if (!Object.prototype.hasOwnProperty.call(index, key)) continue;
    var existing = index[key];
    if (existing && existing.tier === "free") merged[key] = existing;
  }
  var packs = (unlocked && unlocked.packs) || [];
  for (var i = 0; i < packs.length; i++) {
    var p = packs[i];
    // Replace the paid set with this response. A paid pack that is
    // missing from a fresh response leaves the screen. Free packs from
    // the catalog stay. A pack the catalog never announced is accepted.
    // Paid bodies come from POST /api/packs.
    if (isPlainObject(p) && typeof p.drill_id === "string") {
      merged[p.drill_id] = p;
    }
  }
  return merged;
}

/**
 * Fold a catalog that arrived after paid bodies. Free packs and previews
 * from the catalog come in. Only a paid id that already has content
 * overrides the catalog. A free pack in the paid index does not.
 */
function mergeCatalogUnderPaid(catalogIndex, paidIndex) {
  var merged = {};
  var key;
  var catalog = catalogIndex || {};
  var paid = paidIndex || {};
  for (key in catalog) {
    if (Object.prototype.hasOwnProperty.call(catalog, key)) merged[key] = catalog[key];
  }
  for (key in paid) {
    if (!Object.prototype.hasOwnProperty.call(paid, key)) continue;
    if (!paid[key] || paid[key].tier !== "paid") continue;
    if (hasContent(paid[key])) merged[key] = paid[key];
  }
  return merged;
}

/**
 * The pack for a drill, or null.
 *
 * @param {object} index   from indexPacks / applyUnlocked
 * @param {string} drillId
 */
function packForDrill(index, drillId) {
  if (!index || typeof drillId !== "string") return null;
  return Object.prototype.hasOwnProperty.call(index, drillId) ? index[drillId] : null;
}

/**
 * Is this pack withheld from the user?
 *
 * A free pack is never locked. A paid pack is locked unless the user holds the
 * entitlement for ITS area AND the payload has actually been folded in — a pack
 * the user has paid for but whose content has not downloaded yet still has nothing
 * to show, and pretending otherwise would render an empty pack.
 *
 * @param {object} pack
 * @param {function|boolean} isEntitled  (area) => boolean
 */
function isLocked(pack, isEntitled) {
  if (!isPlainObject(pack)) return false;
  if (pack.tier === "free") return false;
  if (!entitledFn(isEntitled)(packPaidArea(pack))) return true;
  return !hasContent(pack);
}

/** Does this pack actually carry renderable content, as opposed to a preview? */
function hasContent(pack) {
  if (!isPlainObject(pack)) return false;
  var comps = pack.components;
  if (!Array.isArray(comps) || comps.length === 0) return false;
  for (var i = 0; i < comps.length; i++) {
    if (isPlainObject(comps[i]) && Array.isArray(comps[i].items) && comps[i].items.length > 0) {
      return true;
    }
  }
  return false;
}

/** Components in render order. Unknown kinds go last, in their original order. */
function orderedComponents(pack) {
  var comps = (isPlainObject(pack) && pack.components) || [];
  return comps
    .map(function (c, i) {
      var rank = KIND_ORDER.indexOf(c && c.kind);
      return { c: c, rank: rank === -1 ? KIND_ORDER.length : rank, i: i };
    })
    .sort(function (a, b) {
      return a.rank - b.rank || a.i - b.i;
    })
    .map(function (entry) {
      return entry.c;
    });
}

/**
 * How many items are in this pack, whether it is a preview or the real thing.
 * Previews carry item_count precisely so a locked card can say "30 cards" and
 * mean it — that specificity is the strongest argument the preview has.
 */
function itemCount(pack) {
  if (!isPlainObject(pack)) return 0;
  if (typeof pack.item_count === "number") return pack.item_count;
  return ((pack.components || []).reduce(function (n, c) {
    return n + (((c && c.items) || []).length);
  }, 0));
}

/**
 * A one-line summary of what is inside, built from a preview's item counts
 * or a real pack's components. Shopper counts join with a comma and a space:
 * "12 cards, 5 worksheets".
 */
function contentsSummary(pack) {
  if (!isPlainObject(pack)) return "";
  var parts = [];
  if (Array.isArray(pack.item_counts)) {
    parts = pack.item_counts.map(function (c) {
      return (c.count || 0) + " " + (c.name || "items");
    });
  } else if (Array.isArray(pack.contents)) {
    parts = pack.contents.map(function (c) {
      return kindLabel(c.kind) + " (" + (c.item_count || 0) + ")";
    });
  } else {
    parts = orderedComponents(pack).map(function (c) {
      return kindLabel(c && c.kind) + " (" + (((c && c.items) || []).length) + ")";
    });
  }
  return parts.join(", ");
}

/**
 * Does this item need an operator render pass before it is a picture?
 *
 * An image item with a synthetic_prompt but no asset_path is a SPEC: the prompt
 * is authored and reviewed, the pixels do not exist yet. The app shows the spec
 * and says so, because a broken image tells the user nothing and a silently
 * omitted item makes the pack look shorter than it is.
 */
function isPendingRender(item) {
  if (!isPlainObject(item) || !item.synthetic_prompt) return false;
  var asset = typeof item.asset_path === "string" ? item.asset_path.trim() : "";
  return !asset;
}

/** Is this item's image AI-generated? Drives the visible synthetic label. */
function isSynthetic(item) {
  return !!(isPlainObject(item) && item.synthetic_prompt);
}

/** Every drill id that has a pack, sorted. */
function drillIdsWithPacks(index) {
  var out = [];
  for (var key in index) {
    if (Object.prototype.hasOwnProperty.call(index, key)) out.push(key);
  }
  return out.sort();
}

/** Counts for the resources overview. */
function summarise(index, isEntitled) {
  var ids = drillIdsWithPacks(index);
  var free = 0;
  var locked = 0;
  var unlockedCount = 0;
  for (var i = 0; i < ids.length; i++) {
    var pack = index[ids[i]];
    if (pack.tier === "free") free++;
    else if (isLocked(pack, isEntitled)) locked++;
    else unlockedCount++;
  }
  return { total: ids.length, free: free, locked: locked, unlocked: unlockedCount };
}

/**
 * What the unlock bar should offer.
 *
 * Entitlement and payload are not the same thing. A successful buy writes
 * support_packs immediately; isLocked stays true until applyUnlocked folds
 * in components/items. If that fetch fails, hiding the bar leaves Locked
 * packs and no control. Retry loads the payload. It must never buy again.
 *
 *   buy    — not entitled
 *   retry  — entitled, no paid pack has content yet
 *   hidden — entitled and at least one paid pack has content
 */
/**
 * Copy for the retry bar. The signal line and the service line match
 * restoreOutcomeMessage. purchase-pending is the pending answer
 * (HTTP 409). purchase-not-active is the older reason and still maps
 * to the same sentence. Either may say the charge is unconfirmed.
 * Play 400/404 and a malformed body are error invalid-token with no
 * reason. loadPaidPacks falls back to that error, so invalid-token
 * here is that fallback. A missing SKU is sku-absent and uses the
 * service line. The address is the
 * one already on the page and the privacy policy. A finished load with
 * no reason uses the service line. While a load is still running and
 * there is no reason yet, the bar says "Loading support packs."
 * Every packs-server error has a line here. A holdback, catalog, or
 * size failure is the service line, not the "already own" fallback.
 */
function supportPackRetryNote(reason) {
  if (reason === "purchase-not-active" || reason === "purchase-pending") {
    return "Play has not confirmed this purchase yet. This does not charge again.";
  }
  if (reason === "invalid-token") {
    // The Restore purchases button and the mailto link sit on the bar.
    // This sentence does not repeat them. It is the same sentence Restore
    // uses after a completed purchase.
    return "Play did not return a receipt we could check. This does not charge again.";
  }
  if (reason === "purchase-revoked") {
    return "Play no longer lists this purchase.";
  }
  if (reason === "list-failed" || reason === "packs-failed" || reason === "timeout") {
    return "The packs could not be loaded. Try again when you have a signal.";
  }
  if (
    !reason ||
    reason === "rate-limited" ||
    reason === "server-error" ||
    reason === "play-api-failure" ||
    reason === "auth-failure" ||
    reason === "invalid-product" ||
    reason === "invalid-package" ||
    reason === "method-not-allowed" ||
    reason === "origin-not-allowed" ||
    reason === "not-found" ||
    reason === "holdback-config-invalid" ||
    reason === "holdback-stamp-missing" ||
    reason === "holdback-stamp-moved" ||
    reason === "holdback-baseline-missing" ||
    reason === "holdback-baseline-invalid" ||
    reason === "allowIds-missing" ||
    reason === "liveAt-missing" ||
    reason === "liveAt-invalid" ||
    reason === "recordedPulls-invalid" ||
    reason === "json-unreadable" ||
    reason === "no-json-no-metadata" ||
    reason === "payload-too-large" ||
    reason === "paid-catalog-missing" ||
    reason === "response-too-large" ||
    reason === "purchase-time-missing" ||
    reason === "not-owned" ||
    reason === "sku-absent"
  ) {
    return "The packs service could not load them. This does not charge again.";
  }
  return "You already own the support packs. They have not loaded yet. This does not charge again.";
}

/**
 * Whether to show the storefront "N free, M locked" line.
 * Returns false when the buyer is entitled and paid delivery did not
 * succeed. That line would count packs they already own as locked.
 * Returns true when they have not bought. When delivery succeeded the
 * page prefers the served-count sentence and does not use this line.
 */
function showFreeLockedProgress(entitled, paidDeliveryOk) {
  return !(entitled && !paidDeliveryOk);
}

function unlockBarMode(index, isEntitled) {
  if (!entitledFn(isEntitled)(DEFAULT_PAID_AREA)) return "buy";
  var ids = drillIdsWithPacks(index);
  for (var i = 0; i < ids.length; i++) {
    var pack = index[ids[i]];
    if (isPlainObject(pack) && pack.tier === "paid" && hasContent(pack)) {
      return "hidden";
    }
  }
  return "retry";
}

var API = {
  PAID_AREAS: PAID_AREAS,
  DEFAULT_PAID_AREA: DEFAULT_PAID_AREA,
  LEGACY_PAID_AREAS: LEGACY_PAID_AREAS,
  packPaidArea: packPaidArea,
  KIND_ORDER: KIND_ORDER,
  KIND_LABELS: KIND_LABELS,
  kindLabel: kindLabel,
  indexPacks: indexPacks,
  applyUnlocked: applyUnlocked,
  mergeCatalogUnderPaid: mergeCatalogUnderPaid,
  packForDrill: packForDrill,
  isLocked: isLocked,
  hasContent: hasContent,
  orderedComponents: orderedComponents,
  itemCount: itemCount,
  contentsSummary: contentsSummary,
  isPendingRender: isPendingRender,
  isSynthetic: isSynthetic,
  drillIdsWithPacks: drillIdsWithPacks,
  summarise: summarise,
  unlockBarMode: unlockBarMode,
  supportPackRetryNote: supportPackRetryNote,
  showFreeLockedProgress: showFreeLockedProgress,
};

if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundResources = API;
}

})();
