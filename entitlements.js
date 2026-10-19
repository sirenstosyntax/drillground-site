"use strict";

// IMPORTANT: the whole module is wrapped in an IIFE.
//
// The app loads these as classic <script> tags, which share ONE global lexical
// scope — so a top-level `const` here would collide with the same name in
// another module and the second file would die silently before defining
// anything. recommend-drills.js and tailboard.js are wrapped the same way; a
// regression test loads them all into one shared context. See tailboard.js for
// the full story.
(function () {
"use strict";

// Entitlements — what the user has unlocked.
//
// EVERY DRILL IS FREE. All 87 of them, unabridged, including the promotion-prep
// study material and the specialty categories. Nothing in the drill library is
// gated and nothing here can gate it — see docs/monetization.md.
//
// What is sold is the CONVENIENCE of not assembling the material. Almost every
// drill opens by telling the user to build something first: thirty condition
// cards, a friction-loss key, a twenty-photo placard deck, a blind-timeline
// template. A firefighter who wants to build their own is welcome to, and the
// drill tells them exactly how. The support packs are for the ones who would
// rather start the reps. See docs/resource-packs-design.md.
//
// One Play SKU unlocks every support pack. Older area names
// (`resource_packs`, `promotion_prep_packs`) are aliases of that one unlock
// so existing pack metadata does not have to be rewritten.
//
// Pure by design: no DOM, no fetch. The store lives in localStorage, read and
// written by the app; this module only decides what an entitlement state means.

var STORAGE_KEY = "drillground.entitlements.v1";

var SUPPORT_PACKS = "support_packs";
var PAID_AREAS = [SUPPORT_PACKS];
var PAID_AREA_ALIASES = ["resource_packs", "promotion_prep_packs"];

// ---------------------------------------------------------------------------
// THE GATE.
//
// Open for public Play charging of the one $29 support-packs unlock
// (`drillground.packs.v1`). hasEntitlement consults the store-receipt-derived
// state. Digital Goods availability — not this flag — is what shows the pack
// catalog and buy button. An ordinary browser never sees packs. Inside the
// TWA an open gate is what stops buyers getting the packs for free.
//
// GATE_OPEN = false is the emergency hold: paid packs render as free and
// there is nothing to buy. Stripe is not a path. Do not consume().
//
// It cannot be enforced client-side: the unlocked payload is a file on a
// public host if someone knows the URL. Real enforcement is the Play receipt.
// This flag decides only what the UI shows. It cannot lock a drill.
// ---------------------------------------------------------------------------
var GATE_OPEN = true;

function canonicalPaidArea(name) {
  if (name === SUPPORT_PACKS) return SUPPORT_PACKS;
  if (PAID_AREA_ALIASES.indexOf(name) !== -1) return SUPPORT_PACKS;
  return name;
}

function isPaidArea(name) {
  return canonicalPaidArea(name) === SUPPORT_PACKS;
}

/**
 * Does the user have this entitlement?
 *
 * @param {string} name        e.g. "support_packs" or a legacy pack area
 * @param {object} [stored]     the parsed entitlements object (from localStorage)
 * @returns {boolean}
 */
function hasEntitlement(name, stored) {
  if (!isPaidArea(name)) return true; // unknown area = not gated = always allowed
  if (!GATE_OPEN) return true; // charging held — packs treated as free
  return !!(stored && stored[SUPPORT_PACKS] === true);
}

/** Parse the stored entitlements safely. Never throws. */
function parseEntitlements(raw) {
  try {
    var parsed = JSON.parse(raw || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    return {};
  }
}

var API = {
  STORAGE_KEY: STORAGE_KEY,
  SUPPORT_PACKS: SUPPORT_PACKS,
  PAID_AREAS: PAID_AREAS,
  PAID_AREA_ALIASES: PAID_AREA_ALIASES,
  GATE_OPEN: GATE_OPEN,
  canonicalPaidArea: canonicalPaidArea,
  isPaidArea: isPaidArea,
  hasEntitlement: hasEntitlement,
  parseEntitlements: parseEntitlements,
};

if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundEntitlements = API;
}

})();
