/* DrillGround app — dependency-free vanilla JS.
 *
 * Loads the published drill library and renders six views:
 *   #/              the library, with a "what should I work on?" prompt on top
 *   #/drill/<id>    a run-ready view of one drill, and the reflect-on-it block
 *   #/assess        the self-assessment — the vision's entry point
 *   #/plan          drills picked from that assessment, each with its reason
 *   #/tailboard     personal reflections, newest first
 *   #/tailboard/call  log a reflection after a call
 *
 * The published library is the app's only data source. It is a build artifact
 * (products/drillground/data/drill_library.published.json) served alongside
 * these files by src/serve-app.js.
 *
 * The only things this app writes are the user's own assessment and their
 * Tailboard reflections, to localStorage on their device. Neither is ever
 * transmitted and there is no share button — see privacy.html. Scoring lives in
 * recommend-drills.js and tailboard.js, which the Node tests cover.
 */
"use strict";

var DATA_URL = "drill_library.published.json";
var RESOURCES_URL = "drill_resources.published.json";
var STORE_RESOURCES_URL = "drill_resources.store.json";

var state = {
  library: null,
  categoryNames: {}, // id -> display name
  filters: { q: "", category: "", scale: "", track: "drills" },
  assessment: null, // saved self-assessment, or null
  draft: null, // in-progress assessment, discarded on cancel
  storageFailed: false, // true when the device refused to persist
  tailboard: { version: 1, entries: [] }, // personal reflections, on-device
  callDraft: null, // in-progress call reflection
  entitlements: {}, // what the user has unlocked (paid areas)
  resources: {}, // drillId -> resource pack (free whole, paid previewed)
  resourcesReady: false, // the resource file resolved, one way or the other
  storeAvailable: false, // Digital Goods / Play billing — TWA only
  purchasePrice: "", // localised price from Play, never a hardcoded number
  purchaseMessage: "", // ordinary buy outcomes (dismissed sheet, no store)
  purchaseRevoked: false, // set only for purchase-revoked, never from message text
  servedPackCount: null, // packCount from POST /api/packs; null until a response
  packsLoading: false, // a packs load is in flight; ignore another tap
};

var view = document.getElementById("view");
var footerNote = document.getElementById("footer-note");
var disclaimerEl = document.getElementById("disclaimer");

// ---- Utilities ------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function titleCase(s) {
  return String(s || "")
    .split("_")
    .map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function categoryLabel(id) {
  return state.categoryNames[id] || titleCase(id);
}

function drillById(id) {
  var drills = (state.library && state.library.drills) || [];
  for (var i = 0; i < drills.length; i++) {
    if (drills[i].id === id) return drills[i];
  }
  return null;
}

// ---- Filtering ------------------------------------------------------------

function matchesFilters(d) {
  var f = state.filters;
  // Study material is a different activity, not a harder drill. Someone
  // scanning for something to run in the bay should never have to filter
  // oral-board tabletops out of the way.
  var mode = d.product_mode || "drill_generation";
  if (f.track === "promotion") {
    if (mode !== "promotion_prep") return false;
  } else if (mode !== "drill_generation") {
    return false;
  }
  if (f.category && d.category !== f.category) return false;
  if (f.scale && d.scale !== f.scale) return false;
  if (f.q) {
    var hay = [
      d.id,
      d.title,
      d.objective,
      categoryLabel(d.category),
      (d.learning_points || []).join(" "),
      (d.roles || []).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    if (hay.indexOf(f.q.toLowerCase()) === -1) return false;
  }
  return true;
}

// ---- Assessment storage ---------------------------------------------------
//
// Stays on the device. No account, no server, never transmitted — see
// privacy.html. That is not only a privacy stance, it is what makes the
// assessment work: a firefighter will tell a private notebook they are shaky on
// mayday. They will not tell their department.

var STORAGE_KEY = "drillground.assessment.v1";

function loadAssessment() {
  try {
    var raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    // Versioned so a later shape change migrates instead of silently
    // misreading old data. Unknown version: treat as absent.
    if (!parsed || parsed.version !== 1) return null;
    if (!parsed.ratings) return null;
    return parsed;
  } catch (e) {
    return null; // storage disabled, private mode, or corrupt JSON
  }
}

function saveAssessment(assessment) {
  assessment.version = 1;
  assessment.updated = new Date().toISOString();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(assessment));
    return true;
  } catch (e) {
    // Storage can be unavailable (private browsing, quota, disabled). The
    // assessment still works for this session — it just will not survive a
    // reload, and we say so rather than pretending it saved.
    return false;
  }
}

function clearAssessment() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    /* nothing to do */
  }
  state.assessment = null;
  state.storageFailed = false;
}

// ---- Tailboard storage ----------------------------------------------------
//
// More sensitive than the assessment. An assessment is an opinion about
// yourself; a call reflection may describe a real incident. Same rule, stated
// louder: on the device, never transmitted, no account, and no share button.

var TAILBOARD_KEY = "drillground.tailboard.v1";

function loadTailboard() {
  try {
    var raw = window.localStorage.getItem(TAILBOARD_KEY);
    if (!raw) return { version: 1, entries: [] };
    var parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return parsed;
  } catch (e) {
    return { version: 1, entries: [] };
  }
}

function saveTailboard(log) {
  try {
    window.localStorage.setItem(TAILBOARD_KEY, JSON.stringify(log));
    return true;
  } catch (e) {
    return false;
  }
}

function tailboard() {
  return window.DrillGroundTailboard;
}

// Drills logged lately, so the plan does not hand back the same drill twice.
function recentIds() {
  return tailboard().recentlyTrainedDrillIds(state.tailboard, new Date().toISOString());
}

// Log a reflection, then offer — never apply — a rating change.
function logReflection(input) {
  var built = tailboard().buildEntry(
    Object.assign({ seed: Math.floor(Math.random() * 100000) }, input),
    new Date().toISOString()
  );
  if (!built.ok) return { ok: false, errors: built.errors };

  state.tailboard = tailboard().addEntry(state.tailboard, built.entry);
  var saved = saveTailboard(state.tailboard);

  var suggestion = null;
  if (state.assessment && state.assessment.ratings) {
    suggestion = tailboard().suggestRatingChange(
      built.entry,
      state.assessment.ratings[built.entry.category]
    );
  }
  return { ok: true, entry: built.entry, saved: saved, suggestion: suggestion };
}

function applySuggestion(suggestion) {
  if (!suggestion || !state.assessment) return;
  state.assessment.ratings[suggestion.category] = suggestion.to;
  saveAssessment(state.assessment);
}

// ---- Assessment view ------------------------------------------------------

var RATING_CHOICES = [
  { value: "solid", label: "Solid", hint: "Trained it recently. I'd back myself tonight." },
  { value: "rusty", label: "Rusty", hint: "I know it, but it's been a while." },
  { value: "shaky", label: "Shaky", hint: "I'd hesitate." },
  { value: "untrained", label: "Never trained", hint: "Never really trained this." },
  { value: "skip", label: "Not my role", hint: "Out of my scope — don't suggest it." },
];

var TIME_CHOICES = [30, 45, 60, 90, 0];

// Promotion prep is a different activity, not a harder drill — see
// docs/promotion-prep-unblock-design.md. The app only offers the choice when
// the library actually holds study material; advertising an empty track is
// worse than not mentioning it.
function libraryHasPromotionPrep() {
  var drills = (state.library && state.library.drills) || [];
  for (var i = 0; i < drills.length; i++) {
    if (drills[i].product_mode === "promotion_prep") return true;
  }
  return false;
}

var TRACK_CHOICES = [
  { value: "drills", label: "Drills I can run" },
  { value: "promotion", label: "Promotion prep" },
];
var STAFFING_CHOICES = [
  { value: "solo", label: "On my own" },
  { value: "partner", label: "Me and one other" },
  { value: "crew", label: "A full crew" },
];

function engine() {
  return window.DrillGroundRecommend;
}

function entitlements() {
  return window.DrillGroundEntitlements;
}

function resources() {
  return window.DrillGroundResources;
}

function purchases() {
  return window.DrillGroundPurchase;
}

// Pack catalog and the buy button exist only inside the Play TWA, where
// Digital Goods (`https://play.google.com/billing`) is available. An
// ordinary browser on the same site stays drills-only — no catalog, no
// buy button. The split is the store detect, not a hardcoded UI switch.
function packsSurfaceOpen() {
  return state.storeAvailable === true;
}

// ---- Support packs --------------------------------------------------------
//
// The material each drill names but does not ship (docs/resource-packs-design.md).
// One Play SKU opens the support packs approved for delivery. The catalog and buy button render
// only when Digital Goods is available (Play TWA). GATE_OPEN is on, so
// packs stay locked until Play says this account owns the SKU.
//
// The TWA fetches the store catalog (free packs + paid previews). After
// purchase or restore it POSTs the Play token to /api/packs. The number of
// packs in that response is the number the page may claim. An ordinary
// browser never loads the catalog as a storefront.

function resourcePackFor(id) {
  return resources().packForDrill(state.resources, id);
}

// A predicate rather than a boolean: entitlements.js still accepts legacy
// area names as aliases of the one support-packs unlock.
function resourcesEntitled(area) {
  return entitlements().hasEntitlement(area, state.entitlements);
}

function packIsLocked(pack) {
  return resources().isLocked(pack, resourcesEntitled);
}

// The banner in the drill detail view. Deliberately a link, not the pack itself:
// a sixteen-card deck rendered between Setup and Run the drill would bury the
// drill, and the drill is what the user came for.
function resourceBanner(d) {
  if (!packsSurfaceOpen()) return "";
  var pack = resourcePackFor(d.id);
  if (!pack) return "";
  var locked = packIsLocked(pack);
  var count = resources().itemCount(pack);
  var summary = resources().contentsSummary(pack);

  var html = '<section class="section callout resource-banner' + (locked ? " locked" : "") + '">';
  html += "<h2>Material for this drill</h2>";
  html += '<p class="resource-banner-title">' + esc(pack.title) + "</p>";
  html += '<p class="resource-contents">' + esc(summary) + " — " + esc(count) + " items</p>";
  if (locked) {
    html += '<p class="resource-lock-note">Part of the support packs. Unlock to open it.</p>';
  }
  html +=
    '<a class="' +
    (locked ? "link-btn" : "primary") +
    '" href="#/resources/' +
    esc(d.id) +
    '">' +
    (locked ? "See what is in it" : "Open the material") +
    "</a>";
  html += "</section>";
  return html;
}

// A drill that needs no pack should say so rather than leave the user wondering
// whether one is missing. Only shown once the resource file has actually loaded.
function resourcesPrompt() {
  if (!packsSurfaceOpen() || !state.resourcesReady) return "";
  var s = resources().summarise(state.resources, resourcesEntitled);
  if (s.total === 0) return "";
  return (
    '<div class="prompt resource-prompt">' +
    "<h2>Support packs</h2>" +
    "<p>Most drills tell you to build something first — a thirty-card deck, an answer key, a " +
    "blind-timeline template. The support packs supply it, so the reps start straight away. " +
    "Every drill stays free.</p>" +
    '<a class="primary" href="#/resources">Open the material</a>' +
    "</div>"
  );
}

function renderResources() {
  if (!packsSurfaceOpen()) {
    window.location.hash = "#/";
    return;
  }
  // The resource file loads after the first render, so a cold load straight to
  // this route arrives before the packs do. Waiting is not the same as having
  // none: redirecting here would break every bookmark and shared link to the
  // material. boot() re-runs the router when the file resolves.
  if (!state.resourcesReady) {
    view.innerHTML =
      '<a class="back" href="#/">← All drills</a>' +
      '<h2 class="view-title">Drill material</h2>' +
      '<p class="lede">Loading the material…</p>';
    return;
  }

  var index = state.resources;
  var ids = resources().drillIdsWithPacks(index);
  if (ids.length === 0) {
    view.innerHTML =
      '<a class="back" href="#/">← All drills</a>' +
      '<h2 class="view-title">Drill material</h2>' +
      '<p class="lede">No material is published yet. Every drill is runnable without it — each one ' +
      "tells you what to build.</p>";
    focusMain();
    return;
  }
  var s = resources().summarise(index, resourcesEntitled);

  var html = '<a class="back" href="#/">← All drills</a>';
  html += '<h2 class="view-title">Support packs</h2>';
  html +=
    '<p class="lede">The decks, case studies, worksheets, and reference cards the drills ask you ' +
    "to build. Every pack removes prep — none of them removes the drill: build the material " +
    "yourself and every drill still runs exactly as written.</p>";
  html += unlockBar();
  if (state.paidDeliveryOk && state.servedPackCount != null) {
    html += '<p class="resource-progress">' + esc(servedPackSentence()) + "</p>";
  } else if (resources().showFreeLockedProgress(resourcesEntitled("support_packs"), state.paidDeliveryOk)) {
    html +=
      '<p class="resource-progress">' +
      s.free +
      " free" +
      (s.locked ? " · " + s.locked + " locked" : "") +
      (s.unlocked ? " · " + s.unlocked + " unlocked" : "") +
      "</p>";
  }

  var open = [];
  var locked = [];
  ids.forEach(function (id) {
    var pack = index[id];
    // A paid preview that was not in the packs response stays withheld.
    // Counting it would advertise packs Red has not passed.
    if (state.paidDeliveryOk && pack && pack.tier === "paid" && packIsLocked(pack)) return;
    if (packIsLocked(pack)) locked.push(id);
    else open.push(id);
  });

  if (open.length) {
    html += '<section class="promo-area">';
    html += '<div class="promo-area-head"><h3>Ready to use</h3>';
    html += '<span class="promo-area-count">' + open.length + "</span></div>";
    html += '<div class="promo-drills">';
    open.forEach(function (id) {
      html += resourceCard(index[id], false);
    });
    html += "</div></section>";
  }

  if (locked.length) {
    html += '<section class="promo-area">';
    html += '<div class="promo-area-head"><h3>Locked</h3>';
    html += '<span class="promo-area-count">' + locked.length + "</span></div>";
    html +=
      '<p class="promo-blurb">Each pack lists what\'s inside (item counts by type), its notes and sources. ' +
      "ENG-011 also shows the text of its first item.</p>";
    html += '<div class="promo-drills">';
    locked.forEach(function (id) {
      html += resourceCard(index[id], true);
    });
    html += "</div></section>";
  }

  view.innerHTML = html;
  wireUnlockBar();
  focusMain();
}

function resourceCard(pack, locked) {
  var d = drillById(pack.drill_id);
  var drillTitle = d ? d.title : pack.drill_id;
  var html =
    '<a class="promo-card' +
    (locked ? " locked" : "") +
    '" href="#/resources/' +
    esc(pack.drill_id) +
    '">';
  html +=
    '<div class="promo-card-top"><span class="promo-card-title">' +
    esc(pack.title) +
    "</span>" +
    (locked
      ? '<span class="tag lock">Locked</span>'
      : pack.tier === "paid"
        ? '<span class="tag">Unlocked</span>'
        : '<span class="tag">Free</span>') +
    "</div>";
  html += '<p class="card-obj">' + esc(pack.summary) + "</p>";
  html +=
    '<p class="resource-contents">' +
    esc(resources().contentsSummary(pack)) +
    " · for " +
    esc(pack.drill_id) +
    " " +
    esc(drillTitle) +
    "</p>";
  html += "</a>";
  return html;
}

function renderResourcePack(drillId) {
  if (!packsSurfaceOpen()) {
    window.location.hash = "#/";
    return;
  }
  // Same as renderResources: a bookmarked pack link arrives before the file.
  if (!state.resourcesReady) {
    view.innerHTML =
      '<a class="back" href="#/resources">← Drill material</a>' + '<p class="lede">Loading…</p>';
    return;
  }

  var pack = resourcePackFor(drillId);
  if (!pack) {
    view.innerHTML =
      '<a class="back" href="#/resources">← Drill material</a>' +
      '<p class="error">No material is published for “' + esc(drillId) + '”.</p>';
    focusMain();
    return;
  }
  var d = drillById(pack.drill_id);
  var locked = packIsLocked(pack);

  var html = '<a class="back" href="#/resources">← Drill material</a>';
  html += '<article class="detail">';
  html += '<div class="card-id">' + esc(pack.drill_id) + "</div>";
  html += "<h1>" + esc(pack.title) + "</h1>";
  html +=
    '<div class="meta-row">' +
    (locked
      ? '<span class="tag lock">Locked</span>'
      : pack.tier === "paid"
        ? '<span class="tag">Unlocked</span>'
        : '<span class="tag">Free</span>') +
    '<span class="tag">' +
    esc(resources().itemCount(pack)) +
    " items</span>" +
    "</div>";
  html += '<p class="lead">' + esc(pack.summary) + "</p>";

  if (d) {
    html +=
      '<p class="resource-for">For <a href="#/drill/' +
      esc(d.id) +
      '">' +
      esc(d.id) +
      " " +
      esc(d.title) +
      "</a></p>";
  }

  // Why this pack exists. Shown to everyone, locked or not — it is the honest
  // argument for the purchase and it is also just useful context.
  html +=
    '<section class="section callout resource-why"><h2>What this saves you</h2><p>' +
    esc(pack.removes_prep) +
    "</p></section>";

  if (locked) {
    html += lockedPackBody(pack);
  } else {
    html += packDisclosureHtml(pack);
    resources()
      .orderedComponents(pack)
      .forEach(function (c) {
        html += resourceComponent(c);
      });
  }

  html += "</article>";
  view.innerHTML = html;
  wireUnlockBar();
  focusMain();
}

// The locked view lists item counts, notes, and sources. ENG-011 also shows
// the text of its first item. Other locked packs do not show a sample.
function packDisclosureHtml(pack) {
  var html = "";
  if (pack.synthetic_caveat) {
    html += '<span class="tag synthetic">Contains AI-generated images</span>';
  }
  if (pack.local_fill_required === true && pack.local_fill_note) {
    html +=
      '<section class="section callout local-fill"><h2>You supply the local part</h2><p>' +
      esc(pack.local_fill_note) +
      "</p></section>";
  }
  if (pack.synthetic_caveat) {
    html +=
      '<section class="section callout synthetic-note"><h2>About the generated images</h2><p>' +
      esc(pack.synthetic_caveat) +
      "</p></section>";
  }
  if (pack.sources && pack.sources.length) {
    html +=
      '<section class="section"><h2>Sources</h2><ul class="plain refs">' +
      pack.sources
        .map(function (r) {
          return "<li>" + esc(r) + "</li>";
        })
        .join("") +
      "</ul></section>";
  }
  return html;
}

function lockedPackBody(pack) {
  var html = packDisclosureHtml(pack);
  html += '<section class="section"><h2>What is in it</h2><ul class="plain">';
  (pack.item_counts || []).forEach(function (c) {
    html += "<li>" + esc(c.count || 0) + " " + esc(c.name || "items") + "</li>";
  });
  html += "</ul></section>";

  if (pack.sample && pack.sample.text) {
    html += '<section class="section callout resource-sample">';
    html += "<h2>One sample</h2>";
    html += "<p>" + esc(pack.sample.text) + "</p>";
    html += "</section>";
  }

  html +=
    '<section class="section callout lock-note"><h2>Part of the support packs</h2><p>' +
    "One purchase opens the support packs approved for delivery — the decks, the case studies, the worksheets, " +
    "the reference cards, and the picture slots the drills already name. The drills themselves " +
    "are unaffected: every one of the 87 is free and still runnable without any of this, because " +
    "each drill already tells you what to build.</p></section>";
  html += unlockBar();
  return html;
}

function unlockBar() {
  if (!packsSurfaceOpen()) return "";
  var mode = resources().unlockBarMode(state.resources, resourcesEntitled);
  if (mode === "hidden") {
    if (!state.purchaseMessage) return "";
    return (
      '<section class="section callout unlock-bar">' +
      '<p class="purchase-message">' +
      esc(state.purchaseMessage) +
      "</p></section>"
    );
  }
  var html = '<section class="section callout unlock-bar">';
  if (state.purchaseMessage) {
    html += '<p class="purchase-message">' + esc(state.purchaseMessage) + "</p>";
  }
  if (mode === "retry") {
    html += "<h2>Load support packs</h2>";
    if (state.paidDeliveryOk && state.servedPackCount === 0) {
      html += "<p>" + esc(servedPackSentence()) + " This does not charge again.</p>";
      html +=
        '<button type="button" class="primary" id="retry-support-packs"' +
        (state.packsLoading ? " disabled" : "") +
        ">Check again</button>";
    } else if (state.paidDeliveryReason === "invalid-token") {
      if (!state.purchaseMessage) {
        html += "<p>" + esc(loadingOrRetryNote()) + "</p>";
      }
      html +=
        '<button type="button" class="primary" id="restore-support-packs">Restore purchases</button>';
      html +=
        '<p class="report-drill"><a href="mailto:grant@sirenstosyntax.com?subject=' +
        encodeURIComponent("DrillGround purchase") +
        '">Email grant@sirenstosyntax.com</a></p>';
    } else {
      if (!state.purchaseMessage) {
        html += "<p>" + esc(loadingOrRetryNote()) + "</p>";
      }
      html +=
        '<button type="button" class="primary" id="retry-support-packs"' +
        (state.packsLoading ? " disabled" : "") +
        ">Load support packs</button>";
    }
    html += "</section>";
    return html;
  }
  var price = state.purchasePrice
    ? " — " + esc(state.purchasePrice)
    : "";
  html += "<h2>Unlock support packs" + price + "</h2>";
  html +=
    "<p>One one-time Play purchase opens the support packs approved for delivery. This is not a second drill library. " +
    "Play shows the price and completes the charge.</p>";
  html +=
    '<button type="button" class="primary" id="buy-support-packs">Unlock support packs' +
    price +
    "</button>";
  html += "</section>";
  return html;
}

function loadingOrRetryNote() {
  if (state.packsLoading && !state.paidDeliveryReason) return "Loading support packs.";
  return resources().supportPackRetryNote(state.paidDeliveryReason);
}

function restoreOutcomeMessage(reason, plainRestore) {
  if (reason === "invalid-token") {
    if (plainRestore) return "Play did not return a receipt we could check.";
    return "Play did not return a receipt we could check. This does not charge again.";
  }
  if (reason === "purchase-revoked") {
    return "Play no longer lists this purchase.";
  }
  if (reason === "purchase-not-active" || reason === "purchase-pending") {
    if (plainRestore) return "Play has not confirmed this purchase yet.";
    return "Play has not confirmed this purchase yet. This does not charge again.";
  }
  if (reason === "not-owned" || reason === "sku-absent") {
    if (plainRestore) return "The packs service could not load them.";
    return "The packs service could not load them. This does not charge again.";
  }
  if (reason === "list-failed" || reason === "packs-failed" || reason === "timeout") {
    return "The packs could not be loaded. Try again when you have a signal.";
  }
  if (plainRestore) return "The packs service could not load them.";
  return "The packs service could not load them. This does not charge again.";
}

function wireUnlockBar() {
  var restore = document.getElementById("restore-support-packs");
  if (restore) {
    restore.addEventListener("click", function () {
      restore.disabled = true;
      state.purchaseMessage = "";
      state.purchaseRevoked = false;
      var restoring =
        state.purchase && typeof state.purchase.restore === "function"
          ? state.purchase.restore({ acknowledge: false })
          : Promise.resolve();
      state.paidDeliveryReason = null;
      Promise.resolve(restoring)
        .then(function () {
          try {
            state.entitlements = entitlements().parseEntitlements(
              window.localStorage.getItem(entitlements().STORAGE_KEY)
            );
          } catch (e) {}
          return loadUnlockedResources("support_packs");
        })
        .then(function (loaded) {
          if (state.purchaseRevoked) {
            state.purchaseMessage = "Play no longer lists this purchase.";
          } else if (!loaded) {
            state.purchaseMessage = restoreOutcomeMessage(state.paidDeliveryReason, true);
          }
          try {
            router();
          } catch (e) {}
        })
        .catch(function () {
          if (state.purchaseRevoked) {
            state.purchaseMessage = "Play no longer lists this purchase.";
          } else {
            state.purchaseMessage = restoreOutcomeMessage(state.paidDeliveryReason || "packs-failed", true);
          }
          try {
            router();
          } catch (e) {}
        });
    });
    return;
  }
  var retry = document.getElementById("retry-support-packs");
  if (retry) {
    retry.addEventListener("click", function () {
      if (state.packsLoading) return;
      retry.disabled = true;
      state.purchaseMessage = "";
      var loading = loadUnlockedResources("support_packs");
      try {
        router();
      } catch (e) {}
      loading
        .then(function (loaded) {
          if (!loaded) state.purchaseMessage = restoreOutcomeMessage(state.paidDeliveryReason);
          try {
            router();
          } catch (e) {}
        })
        .catch(function () {
          state.purchaseMessage = restoreOutcomeMessage(state.paidDeliveryReason || "packs-failed");
          try {
            router();
          } catch (e) {}
        });
    });
    return;
  }
  var btn = document.getElementById("buy-support-packs");
  if (!btn || !state.purchase) return;
  btn.addEventListener("click", function () {
    btn.disabled = true;
    state.purchaseMessage = "";
    state.purchase
      .buy("support_packs")
      .then(function (result) {
        if (result && result.ok) {
          try {
            state.entitlements = entitlements().parseEntitlements(
              window.localStorage.getItem(entitlements().STORAGE_KEY)
            );
          } catch (e) {
            state.entitlements.support_packs = true;
          }
          return loadUnlockedResources("support_packs").then(function (loaded) {
            if (loaded === "pending") {
              state.purchaseMessage = "Play has not confirmed this purchase yet.";
            } else if (!loaded) {
              state.purchaseMessage =
                "Purchase completed. " + restoreOutcomeMessage(state.paidDeliveryReason);
            } else if (result.acknowledged === false) {
              state.purchaseMessage =
                "Unlocked. Play has not confirmed the charge yet. We will keep trying; this does not charge again.";
            } else {
              state.purchaseMessage = "";
            }
            router();
          });
        }
        state.purchaseMessage = buyFailureMessage(result);
        router();
      })
      .catch(function () {
        state.purchaseMessage = "The purchase did not complete. Try again.";
        router();
      });
  });
}

function buyFailureMessage(result) {
  var reason = result && result.reason;
  if (reason === "payment-failed") {
    return "Purchase cancelled or declined. Nothing was charged.";
  }
  if (reason === "no-store") {
    return "Play Billing is not available on this surface.";
  }
  return "The purchase did not complete. Try again.";
}

function servedPackSentence() {
  var n = state.servedPackCount;
  // The empty sentence is only a confirmed delivery of zero packs.
  // A failure leaves paidDeliveryOk false and takes the try-again path.
  if (!state.paidDeliveryOk || n == null) return "";
  if (n === 0) {
    return "Your purchase is confirmed. No support packs are approved for delivery yet.";
  }
  return (
    n +
    " support pack" +
    (n === 1 ? " is" : "s are") +
    " available with this purchase."
  );
}

function formatStorePrice(details) {
  if (!details || !details.price) return "";
  var p = details.price;
  if (p.currency && p.value) return p.currency + " " + p.value;
  return "";
}

function resourceComponent(c) {
  var html = '<section class="section resource-component">';
  html +=
    "<h2>" +
    esc(resources().kindLabel(c.kind)) +
    " — " +
    esc(c.label) +
    "</h2>";
  html += '<p class="resource-instructions">' + esc(c.instructions) + "</p>";
  html += '<ol class="resource-items">';
  (c.items || []).forEach(function (item) {
    html += "<li>" + resourceItem(item, c.kind) + "</li>";
  });
  html += "</ol></section>";
  return html;
}

function resourceItem(item, kind) {
  if (!item) return "";
  var html = "";

  // An image spec whose pixels do not exist yet says so. A broken <img> tells
  // the user nothing and silently dropping the item makes the pack look shorter
  // than it is.
  if (resources().isSynthetic(item)) {
    if (item.asset_path) {
      html +=
        '<img class="resource-image" src="' +
        esc(item.asset_path) +
        '" alt="' +
        esc(item.alt || "") +
        '" loading="lazy" />';
      html += '<p class="synthetic-label">AI-generated image — not a real fire scene.</p>';
    } else {
      html += '<p class="resource-pending">Image not rendered yet. What it will show: ' + esc(item.alt || "") + "</p>";
    }
  } else if (item.asset_path) {
    html +=
      '<img class="resource-image" src="' +
      esc(item.asset_path) +
      '" alt="' +
      esc(item.alt || "") +
      '" loading="lazy" />';
  }

  html += '<p class="resource-item-text">' + esc(item.text) + "</p>";

  if (item.fields && item.fields.length) {
    html += '<ul class="resource-fields">';
    item.fields.forEach(function (f) {
      html += "<li>" + esc(f) + "</li>";
    });
    html += "</ul>";
  }

  if (item.answer) {
    html +=
      '<p class="resource-answer"><strong>' +
      (kind === "card_deck" ? "Back of the card." : "What a correct answer contains.") +
      "</strong> " +
      esc(item.answer) +
      "</p>";
  }
  if (item.teaching_focus) {
    html += '<p class="resource-focus">Training: ' + esc(item.teaching_focus) + "</p>";
  }
  if (item.link) {
    html +=
      '<p class="resource-link"><a href="' +
      esc(item.link) +
      '" rel="noopener noreferrer" target="_blank">Open the source</a></p>';
  }
  if (item.source) {
    html += '<p class="resource-source">' + esc(item.source) + "</p>";
  }
  return html;
}

// ---- Promotion prep track -------------------------------------------------
//
// The first paid area (docs/promotion-track-design.md). A study path, not a
// filtered list: the four parts of a promotional process, the drills in each,
// and progress derived from Tailboard — a drill the user has reflected on is
// "practiced". Gating reads from entitlements(), which is stubbed open today,
// so nothing is actually locked yet; the preview path is built and inert until
// the gate closes.

var PROMOTION_AREAS = [
  {
    key: "oral_board",
    label: "Oral board",
    blurb: "Answering aloud under a panel — leadership presence, accountability, and holding a position under probing.",
  },
  {
    key: "written_exam_prep",
    label: "Written exam",
    blurb: "Multiple-choice reasoning and the discipline of a timed set — supervision, policy judgment, and reading the stem.",
  },
  {
    key: "tactical_scenario",
    label: "Tactical scenario",
    blurb: "Size-up, priorities, and resource decisions under a clock, defended out loud.",
  },
  {
    key: "personnel_leadership",
    label: "Leadership judgment",
    blurb: "Coaching, correction, and rebuilding trust — the people problems boards test and candidates least prepare.",
  },
];

function promotionDrills() {
  var drills = (state.library && state.library.drills) || [];
  return drills.filter(function (d) {
    return d.product_mode === "promotion_prep";
  });
}

// A drill counts as practiced if the user has logged any Tailboard reflection
// against it. Reuses the reflect loop rather than inventing a second store.
function practicedDrillIds() {
  var out = {};
  var entries = (state.tailboard && state.tailboard.entries) || [];
  entries.forEach(function (e) {
    if (e && e.drillId) out[e.drillId] = true;
  });
  return out;
}

function renderPromotion() {
  var all = promotionDrills();
  if (all.length === 0) {
    // Should not happen once content is published, but never advertise an empty
    // track.
    window.location.hash = "#/";
    return;
  }

  var practiced = practicedDrillIds();

  var html = '<a class="back" href="#/">← All drills</a>';
  html += '<h2 class="view-title">Promotion prep</h2>';
  html +=
    '<p class="lede">Structured study for a promotional process — oral board, written exam, ' +
    "tactical scenarios, and leadership judgment. Work through each part; log how it went and it " +
    "shows here.</p>";

  var doneCount = all.filter(function (d) {
    return practiced[d.id];
  }).length;
  html +=
    '<p class="promo-progress">Practiced ' + doneCount + " of " + all.length + " across the four areas.</p>";

  PROMOTION_AREAS.forEach(function (area) {
    var inArea = all.filter(function (d) {
      return d.subcategory === area.key;
    });
    if (inArea.length === 0) return;
    var areaDone = inArea.filter(function (d) {
      return practiced[d.id];
    }).length;

    html += '<section class="promo-area">';
    html +=
      '<div class="promo-area-head"><h3>' +
      esc(area.label) +
      '</h3><span class="promo-area-count">' +
      areaDone +
      "/" +
      inArea.length +
      " practiced</span></div>";
    html += '<p class="promo-blurb">' + esc(area.blurb) + "</p>";
    html += '<div class="promo-drills">';
    inArea.forEach(function (d) {
      html += promotionCard(d, !!practiced[d.id]);
    });
    html += "</div></section>";
  });

  view.innerHTML = html;
}

// One drill in the track. Always a link to the full drill: promotion-prep study
// material is free like every other drill (docs/monetization.md). The locked
// preview this function used to render is gone, along with the paid area that
// drove it — what is sold now is the assembled material, not the drill.
function promotionCard(d, isPracticed) {
  var tag = isPracticed ? '<span class="tag went-well">Practiced</span>' : "";
  return (
    '<a class="promo-card" href="#/drill/' +
    esc(d.id) +
    '"><div class="promo-card-top"><span class="promo-card-title">' +
    esc(d.title) +
    "</span>" +
    tag +
    "</div><p class=\"card-obj\">" +
    esc(d.objective || "") +
    "</p></a>"
  );
}

// The draft is separate from the saved assessment so a user can change their
// mind mid-assessment without clobbering what they already had.
function startDraft() {
  var existing = state.assessment;
  state.draft = {
    ratings: existing ? JSON.parse(JSON.stringify(existing.ratings)) : {},
    optedIn: existing && existing.optedIn ? existing.optedIn.slice() : [],
    context: existing
      ? JSON.parse(JSON.stringify(existing.context))
      : { staffing: "crew", minutes: 0, track: "drills" },
  };
}

function renderAssess() {
  if (!state.draft) startDraft();
  var draft = state.draft;
  var E = engine();
  var core = E.CORE_CATEGORIES;
  var optIn = E.OPT_IN_CATEGORIES;

  var html = '<a class="back" href="#/">← All drills</a>';
  html += '<h2 class="view-title">What should I work on?</h2>';
  html +=
    '<p class="lede">Rate yourself honestly — this stays on your phone and goes nowhere else. ' +
    "Skip anything outside your scope.</p>";

  html += '<div class="assess">';
  core.forEach(function (id) {
    html += assessRow(id, draft.ratings[id]);
  });
  html += "</div>";

  // Specialty categories. Off by default: telling a firefighter their trench
  // rescue is weak when their department does not do trench rescue is noise.
  html += '<div class="specialty">';
  html += "<h3>Specialty areas</h3>";
  html +=
    '<p class="lede">These assume technician-level scope. Turn on only what applies to you.</p>';
  optIn.forEach(function (id) {
    var on = draft.optedIn.indexOf(id) !== -1;
    html +=
      '<button class="toggle' +
      (on ? " on" : "") +
      '" data-optin="' +
      esc(id) +
      '" aria-pressed="' +
      (on ? "true" : "false") +
      '">' +
      (on ? "✓ " : "") +
      esc(categoryLabel(id)) +
      "</button>";
  });
  html += '<div class="assess">';
  optIn.forEach(function (id) {
    if (draft.optedIn.indexOf(id) !== -1) html += assessRow(id, draft.ratings[id]);
  });
  html += "</div>";
  html += "</div>";

  // Context — the vision's "fit for the user's resources, staffing, and time".
  html += '<div class="context">';
  html += "<h3>Training today</h3>";
  html += '<p class="ctx-label">Who is with you?</p><div class="filter-row">';
  STAFFING_CHOICES.forEach(function (s) {
    html += ctxBtn("staffing", s.value, s.label, draft.context.staffing === s.value);
  });
  html += "</div>";
  html += '<p class="ctx-label">How long have you got?</p><div class="filter-row">';
  TIME_CHOICES.forEach(function (m) {
    html += ctxBtn("minutes", m, m ? m + " min" : "No limit", draft.context.minutes === m);
  });
  html += "</div>";

  if (libraryHasPromotionPrep()) {
    html += '<p class="ctx-label">What are you working toward?</p><div class="filter-row">';
    TRACK_CHOICES.forEach(function (t) {
      html += ctxBtn(
        "track",
        t.value,
        t.label,
        (draft.context.track || "drills") === t.value
      );
    });
    html += "</div>";
  }

  html += "</div>";

  var rated = countRated(draft);
  html += '<div class="assess-actions">';
  html +=
    '<button class="primary" id="show-plan"' +
    (rated === 0 ? " disabled" : "") +
    ">" +
    (rated === 0 ? "Rate at least one area" : "Show me what to train") +
    "</button>";
  if (state.assessment) {
    html += '<button class="link-btn" id="clear-assessment">Clear my assessment</button>';
  }
  html += "</div>";

  view.innerHTML = html;
  wireAssess();
}

function assessRow(id, current) {
  var html = '<div class="assess-row"><div class="assess-cat">' + esc(categoryLabel(id)) + "</div>";
  html += '<div class="assess-choices" role="group" aria-label="' + esc(categoryLabel(id)) + '">';
  RATING_CHOICES.forEach(function (c) {
    var on = current === c.value;
    html +=
      '<button class="rate' +
      (on ? " on" : "") +
      " r-" +
      c.value +
      '" data-cat="' +
      esc(id) +
      '" data-rating="' +
      c.value +
      '" title="' +
      esc(c.hint) +
      '" aria-pressed="' +
      (on ? "true" : "false") +
      '">' +
      esc(c.label) +
      "</button>";
  });
  html += "</div></div>";
  return html;
}

function ctxBtn(group, value, label, on) {
  return (
    '<button class="chip' +
    (on ? " on" : "") +
    '" data-ctx="' +
    group +
    '" data-value="' +
    esc(value) +
    '" aria-pressed="' +
    (on ? "true" : "false") +
    '">' +
    esc(label) +
    "</button>"
  );
}

function countRated(draft) {
  var n = 0;
  var E = engine();
  Object.keys(draft.ratings).forEach(function (id) {
    var r = draft.ratings[id];
    if (r === E.SKIP) return;
    if (E.RATINGS.indexOf(r) === -1) return;
    if (E.isOptIn(id) && draft.optedIn.indexOf(id) === -1) return;
    n++;
  });
  return n;
}

function wireAssess() {
  Array.prototype.forEach.call(view.querySelectorAll(".rate"), function (btn) {
    btn.addEventListener("click", function () {
      var cat = btn.getAttribute("data-cat");
      var rating = btn.getAttribute("data-rating");
      // Tapping the active answer clears it — nothing is forced.
      state.draft.ratings[cat] = state.draft.ratings[cat] === rating ? undefined : rating;
      if (!state.draft.ratings[cat]) delete state.draft.ratings[cat];
      renderAssess();
    });
  });

  Array.prototype.forEach.call(view.querySelectorAll("[data-optin]"), function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.getAttribute("data-optin");
      var at = state.draft.optedIn.indexOf(id);
      if (at === -1) state.draft.optedIn.push(id);
      else state.draft.optedIn.splice(at, 1);
      renderAssess();
    });
  });

  Array.prototype.forEach.call(view.querySelectorAll("[data-ctx]"), function (btn) {
    btn.addEventListener("click", function () {
      var group = btn.getAttribute("data-ctx");
      var value = btn.getAttribute("data-value");
      state.draft.context[group] = group === "minutes" ? parseInt(value, 10) : value;
      renderAssess();
    });
  });

  var show = document.getElementById("show-plan");
  if (show) {
    show.addEventListener("click", function () {
      var assessment = {
        ratings: state.draft.ratings,
        optedIn: state.draft.optedIn,
        context: state.draft.context,
      };
      state.storageFailed = !saveAssessment(assessment);
      state.assessment = assessment;
      state.draft = null;
      window.location.hash = "#/plan";
    });
  }

  var clear = document.getElementById("clear-assessment");
  if (clear) {
    clear.addEventListener("click", function () {
      clearAssessment();
      state.draft = null;
      renderAssess();
    });
  }
}

// ---- Tailboard views ------------------------------------------------------

var WENT_CHOICES = [
  { value: "well", label: "Went well" },
  { value: "ok", label: "OK" },
  { value: "rough", label: "Rough" },
];

// The one-tap logger that sits on a drill page. Deliberately three buttons and
// nothing else: the note is offered only after, because a form nobody fills in
// after a shift feeds nothing.
function drillReflectBlock(d) {
  var html = '<section class="section reflect" id="reflect">';
  html += "<h2>Ran this?</h2>";
  html += '<p class="reflect-q">How did it go?</p><div class="filter-row">';
  WENT_CHOICES.forEach(function (w) {
    html +=
      '<button class="chip went" data-went="' +
      w.value +
      '" data-drill="' +
      esc(d.id) +
      '" data-category="' +
      esc(d.category) +
      '">' +
      esc(w.label) +
      "</button>";
  });
  html += "</div>";
  html += '<p class="reflect-note-hint">Stays on your phone. Nobody else sees it.</p>';
  html += "</section>";
  return html;
}

function wireDrillReflect() {
  Array.prototype.forEach.call(view.querySelectorAll(".went"), function (btn) {
    btn.addEventListener("click", function () {
      var result = logReflection({
        kind: "drill",
        drillId: btn.getAttribute("data-drill"),
        category: btn.getAttribute("data-category"),
        went: btn.getAttribute("data-went"),
      });
      if (!result.ok) return;
      renderReflectConfirmation(result);
    });
  });
}

// After logging: confirm, offer the optional note, and offer the rating change.
function renderReflectConfirmation(result) {
  var el = document.getElementById("reflect");
  if (!el) return;
  var html = "<h2>Logged</h2>";

  if (!result.saved) {
    html +=
      '<p class="callout warn">Your device would not let the app save this, so it will be gone ' +
      "after a reload.</p>";
  }

  if (result.suggestion) {
    // Wrapped so accepting or declining replaces the whole question cleanly,
    // rather than leaving the prompt sitting next to its own answer.
    html += '<div id="suggestion-block">';
    html +=
      '<p class="reflect-q">' +
      esc(tailboard().describeSuggestion(result.suggestion, categoryLabel(result.suggestion.category))) +
      "</p>";
    html += '<div class="filter-row">';
    html += '<button class="chip" id="accept-suggestion">Yes, update it</button>';
    html += '<button class="chip" id="decline-suggestion">Leave it</button>';
    html += "</div></div>";
  }

  html += '<p class="reflect-q">Anything worth remembering? (optional)</p>';
  html +=
    '<textarea class="note" id="reflect-note" rows="2" maxlength="280" ' +
    'placeholder="Keep it about you — no names or patient details."></textarea>';
  html += '<div class="filter-row"><button class="chip" id="save-note">Save note</button>';
  html += '<a class="link-btn" href="#/tailboard">See my Tailboard</a></div>';

  el.innerHTML = html;

  var block = document.getElementById("suggestion-block");
  var accept = document.getElementById("accept-suggestion");
  if (accept && block) {
    accept.addEventListener("click", function () {
      applySuggestion(result.suggestion);
      block.innerHTML =
        '<p class="reflect-q">' +
        esc(categoryLabel(result.suggestion.category)) +
        " is now " +
        esc(result.suggestion.to) +
        ". Your next plan will reflect that.</p>";
    });
  }
  var decline = document.getElementById("decline-suggestion");
  if (decline && block) {
    decline.addEventListener("click", function () {
      block.innerHTML = '<p class="reflect-note-hint">Left as it was.</p>';
    });
  }

  var save = document.getElementById("save-note");
  if (save) {
    save.addEventListener("click", function () {
      var box = document.getElementById("reflect-note");
      var note = box ? box.value.trim() : "";
      if (note) {
        // Replace the just-written entry with a noted version.
        state.tailboard.entries[0].note = note.slice(0, tailboard().NOTE_MAX);
        saveTailboard(state.tailboard);
      }
      save.textContent = note ? "Saved" : "Nothing to save";
      save.disabled = true;
    });
  }
}

function renderTailboard() {
  var log = state.tailboard;
  var entries = (log && log.entries) || [];

  var html = '<a class="back" href="#/">← All drills</a>';
  html += '<h2 class="view-title">Tailboard</h2>';
  html +=
    '<p class="lede">Your own record of what you trained and how it went. It stays on this ' +
    "device — there is no share button and nobody is reading it.</p>";

  html += '<div class="assess-actions"><a class="primary" href="#/tailboard/call">Log a call</a></div>';

  if (entries.length === 0) {
    html +=
      '<p class="empty">Nothing logged yet. Run a drill and tell it how you got on, or log a ' +
      "call you just came back from.</p>";
  } else {
    html += '<div class="tb-list">';
    entries.forEach(function (e) {
      html += tailboardCard(e);
    });
    html += "</div>";
  }

  view.innerHTML = html;

  Array.prototype.forEach.call(view.querySelectorAll("[data-delete]"), function (btn) {
    btn.addEventListener("click", function () {
      state.tailboard = tailboard().removeEntry(state.tailboard, btn.getAttribute("data-delete"));
      saveTailboard(state.tailboard);
      renderTailboard();
    });
  });
}

function tailboardCard(e) {
  var when = "";
  try {
    when = new Date(e.at).toLocaleDateString();
  } catch (err) {
    when = "";
  }
  var d = e.drillId ? drillById(e.drillId) : null;
  var title = d ? d.title : e.kind === "call" ? "A call" : e.drillId || "A drill";

  var html = '<div class="tb-card">';
  html += '<div class="tb-head">';
  html += '<span class="tag went-' + esc(e.went) + '">' + esc(wentLabel(e.went)) + "</span>";
  html += '<span class="tb-when">' + esc(when) + "</span>";
  html += "</div>";
  if (d) {
    html += '<a class="tb-title" href="#/drill/' + esc(d.id) + '">' + esc(title) + "</a>";
  } else {
    html += '<div class="tb-title">' + esc(title) + "</div>";
  }
  html += '<div class="tb-cat">' + esc(categoryLabel(e.category)) + "</div>";
  if (e.note) html += '<p class="tb-note">' + esc(e.note) + "</p>";
  // Someone will write something they regret and want that one entry gone.
  html += '<button class="link-btn" data-delete="' + esc(e.id) + '">Delete</button>';
  html += "</div>";
  return html;
}

function wentLabel(w) {
  for (var i = 0; i < WENT_CHOICES.length; i++) {
    if (WENT_CHOICES[i].value === w) return WENT_CHOICES[i].label;
  }
  return w;
}

// Logging a call — no drill to hang it on, so the user names the area it touched.
function renderCallLog() {
  if (!state.callDraft) state.callDraft = { category: "", went: "", note: "" };
  var draft = state.callDraft;
  var E = engine();
  var cats = E.CORE_CATEGORIES.concat(E.OPT_IN_CATEGORIES);

  var html = '<a class="back" href="#/tailboard">← Tailboard</a>';
  html += '<h2 class="view-title">Log a call</h2>';
  html +=
    '<p class="lede">A quick note to yourself about how you got on. This is not an AAR and it ' +
    "goes to nobody.</p>";

  html += '<p class="ctx-label">What did it touch?</p><div class="filter-row">';
  cats.forEach(function (c) {
    html += ctxBtn("category", c, categoryLabel(c), draft.category === c);
  });
  html += "</div>";

  html += '<p class="ctx-label">How did you do?</p><div class="filter-row">';
  WENT_CHOICES.forEach(function (w) {
    html += ctxBtn("went", w.value, w.label, draft.went === w.value);
  });
  html += "</div>";

  html += '<p class="ctx-label">Anything worth remembering? (optional)</p>';
  html +=
    '<textarea class="note" id="call-note" rows="3" maxlength="280" ' +
    'placeholder="Keep it about you — no names or patient details.">' +
    esc(draft.note) +
    "</textarea>";

  var ready = draft.category && draft.went;
  html += '<div class="assess-actions">';
  html +=
    '<button class="primary" id="save-call"' +
    (ready ? "" : " disabled") +
    ">" +
    (ready ? "Save to my Tailboard" : "Pick an area and how it went") +
    "</button></div>";

  view.innerHTML = html;

  Array.prototype.forEach.call(view.querySelectorAll("[data-ctx]"), function (btn) {
    btn.addEventListener("click", function () {
      var box = document.getElementById("call-note");
      if (box) state.callDraft.note = box.value;
      var group = btn.getAttribute("data-ctx");
      var value = btn.getAttribute("data-value");
      state.callDraft[group] = state.callDraft[group] === value ? "" : value;
      renderCallLog();
    });
  });

  var save = document.getElementById("save-call");
  if (save) {
    save.addEventListener("click", function () {
      var box = document.getElementById("call-note");
      var result = logReflection({
        kind: "call",
        category: draft.category,
        went: draft.went,
        note: box ? box.value : "",
      });
      if (!result.ok) return;
      state.callDraft = null;
      window.location.hash = "#/tailboard";
    });
  }
}

// ---- Plan view ------------------------------------------------------------

function renderPlan() {
  var a = state.assessment;
  if (!a) {
    window.location.hash = "#/assess";
    return;
  }

  var result = engine().recommendDrills({
    drills: (state.library && state.library.drills) || [],
    ratings: a.ratings,
    optedIn: a.optedIn,
    context: a.context,
    recentDrillIds: recentIds(),
    categoryNames: state.categoryNames,
    limit: 5,
  });

  var html = '<a class="back" href="#/">← All drills</a>';
  html += '<h2 class="view-title">What to train next</h2>';

  if (state.storageFailed) {
    html +=
      '<p class="callout warn">Your device would not let the app save this, so it will be gone ' +
      "after a reload. Everything below still works for now.</p>";
  }

  var ctx = describeContext(a.context);
  html += '<p class="lede">Based on what you told us' + (ctx ? ", " + ctx : "") + ".</p>";

  if (result.recommendations.length === 0) {
    html +=
      '<p class="empty">Nothing in the library matches those constraints yet — try allowing more ' +
      "time, or training with someone. You can always browse everything.</p>";
  } else {
    html += '<div class="plan">';
    result.recommendations.forEach(function (rec, i) {
      html += planCard(rec, i + 1);
    });
    html += "</div>";
  }

  // Advisory, not prescriptive: the whole library is always one tap away.
  html += '<div class="assess-actions">';
  html += '<a class="primary" href="#/assess">Change my answers</a>';
  html += '<a class="link-btn" href="#/">Browse all ' + ((state.library.drills || []).length) + " drills</a>";
  html += "</div>";

  view.innerHTML = html;
}

function planCard(rec, n) {
  var d = rec.drill;
  var html = '<div class="plan-card">';
  html += '<div class="plan-rank">' + n + "</div>";
  html += '<div class="plan-body">';
  html += '<a class="plan-title" href="#/drill/' + esc(d.id) + '">' + esc(d.title) + "</a>";
  html += '<div class="card-id">' + esc(d.id) + " · " + esc(d.duration_min) + " min</div>";
  html += '<p class="card-obj">' + esc(d.objective || "") + "</p>";
  // A recommendation the user cannot interrogate is an instruction, and this
  // product is a coach. Always show the why.
  html += '<ul class="why">';
  rec.reasons.forEach(function (r) {
    html += "<li>" + esc(r) + "</li>";
  });
  html += "</ul></div></div>";
  return html;
}

function describeContext(ctx) {
  if (!ctx) return "";
  var bits = [];
  if (ctx.staffing === "solo") bits.push("training on your own");
  else if (ctx.staffing === "partner") bits.push("training with one other");
  if (ctx.minutes) bits.push("with " + ctx.minutes + " minutes");
  return bits.join(" ");
}

// The library list is still the home view — the vision is advisory, so the
// assessment is an offer, never a gate. This block is what turns "here are 59
// drills, good luck" into "here is what to work on".
function assessPrompt() {
  if (!state.assessment) {
    return (
      '<div class="prompt">' +
      "<h2>Not sure what to train?</h2>" +
      "<p>Answer a few questions about where you stand and get drills picked for you — " +
      "your experience, who is with you, and the time you have.</p>" +
      '<a class="primary" href="#/assess">Find my next drill</a>' +
      "</div>"
    );
  }

  var result = engine().recommendDrills({
    drills: (state.library && state.library.drills) || [],
    ratings: state.assessment.ratings,
    optedIn: state.assessment.optedIn,
    context: state.assessment.context,
    recentDrillIds: recentIds(),
    categoryNames: state.categoryNames,
    limit: 3,
  });

  if (result.recommendations.length === 0) return "";

  var html = '<div class="prompt">';
  html += "<h2>Picked for you</h2>";
  html += '<div class="mini-plan">';
  result.recommendations.forEach(function (rec) {
    html +=
      '<a class="mini" href="#/drill/' +
      esc(rec.drill.id) +
      '"><strong>' +
      esc(rec.drill.title) +
      "</strong><span>" +
      esc(rec.reasons[0]) +
      "</span></a>";
  });
  html += "</div>";
  html += '<a class="link-btn" href="#/plan">See the full plan</a>';
  html += "</div>";
  return html;
}

// A second entry point for the promotion track, shown only when promotion-prep
// content exists. Separate from the drill prompt because it is a different
// intent — preparing for an exam, not training for a shift.
function promotionPrompt() {
  if (!libraryHasPromotionPrep()) return "";
  return (
    '<div class="prompt promo-prompt">' +
    "<h2>Chasing a promotion?</h2>" +
    "<p>A structured study track — oral board, written exam, tactical scenarios, and leadership " +
    "judgment. Built for a candidate, not a shift.</p>" +
    '<a class="primary" href="#/promotion">Open promotion prep</a>' +
    "</div>"
  );
}

// ---- List view ------------------------------------------------------------

function renderList() {
  var drills = (state.library && state.library.drills) || [];
  var cats = (state.library && state.library.categories) || [];
  var scales =
    (state.library.meta &&
      state.library.meta.schema_notes &&
      state.library.meta.schema_notes.scale) ||
    [];

  var visible = drills.filter(matchesFilters);

  var html = assessPrompt();
  html += promotionPrompt();
  html += resourcesPrompt();
  html += '<div class="controls">';
  html +=
    '<input class="search" id="search" type="search" ' +
    'placeholder="Search drills — e.g. standpipe, mayday, RIT" ' +
    'value="' +
    esc(state.filters.q) +
    '" aria-label="Search drills" />';

  // Category chips
  html += '<div class="filter-row" role="group" aria-label="Filter by category">';
  html += chip("category", "", "All categories");
  cats.forEach(function (c) {
    html += chip("category", c.id, c.name);
  });
  html += "</div>";

  // Track chips — only when the library actually holds study material.
  if (libraryHasPromotionPrep()) {
    html += '<div class="filter-row" role="group" aria-label="Drills or promotion prep">';
    TRACK_CHOICES.forEach(function (t) {
      html += chip("track", t.value, t.label);
    });
    html += "</div>";
  }

  // Scale chips
  html += '<div class="filter-row" role="group" aria-label="Filter by scale">';
  html += chip("scale", "", "Any scale");
  scales.forEach(function (s) {
    html += chip("scale", s, titleCase(s));
  });
  html += "</div>";
  html += "</div>"; // controls

  html +=
    '<p class="result-count">' +
    visible.length +
    (visible.length === 1 ? " drill" : " drills") +
    (visible.length !== drills.length ? " of " + drills.length : "") +
    "</p>";

  if (visible.length === 0) {
    html +=
      '<p class="empty">No drills match. Try clearing a filter or a different search.</p>';
  } else {
    html += '<div class="card-grid">';
    visible.forEach(function (d) {
      html += drillCard(d);
    });
    html += "</div>";
  }

  view.innerHTML = html;

  // Wire controls
  var search = document.getElementById("search");
  search.addEventListener("input", function () {
    state.filters.q = search.value;
    // Re-render only the results, keep focus in the box.
    updateResultsInPlace();
  });

  Array.prototype.forEach.call(view.querySelectorAll(".chip"), function (btn) {
    btn.addEventListener("click", function () {
      var group = btn.getAttribute("data-group");
      var value = btn.getAttribute("data-value");
      // Category and scale toggle off to mean "any". Track is a mode, not a
      // filter — one of the two is always active, so it never clears to empty.
      if (group === "track") {
        state.filters.track = value;
      } else {
        state.filters[group] = state.filters[group] === value ? "" : value;
      }
      renderList();
    });
  });
}

// Update just the count + grid so typing in search doesn't lose focus.
function updateResultsInPlace() {
  var drills = (state.library && state.library.drills) || [];
  var visible = drills.filter(matchesFilters);
  var count = view.querySelector(".result-count");
  var grid = view.querySelector(".card-grid");
  var empty = view.querySelector(".empty");

  if (count) {
    count.textContent =
      visible.length +
      (visible.length === 1 ? " drill" : " drills") +
      (visible.length !== drills.length ? " of " + drills.length : "");
  }

  var listHtml =
    visible.length === 0
      ? ""
      : visible
          .map(function (d) {
            return drillCard(d);
          })
          .join("");

  if (visible.length === 0) {
    if (grid) grid.remove();
    if (!empty) {
      var p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No drills match. Try clearing a filter or a different search.";
      count.insertAdjacentElement("afterend", p);
    }
  } else {
    if (empty) empty.remove();
    if (grid) {
      grid.innerHTML = listHtml;
    } else {
      var div = document.createElement("div");
      div.className = "card-grid";
      div.innerHTML = listHtml;
      count.insertAdjacentElement("afterend", div);
    }
  }
}

function chip(group, value, label) {
  var pressed = state.filters[group] === value ? "true" : "false";
  return (
    '<button type="button" class="chip" data-group="' +
    esc(group) +
    '" data-value="' +
    esc(value) +
    '" aria-pressed="' +
    pressed +
    '">' +
    esc(label) +
    "</button>"
  );
}

function drillCard(d) {
  var tags = [];
  tags.push('<span class="tag">' + esc(categoryLabel(d.category)) + "</span>");
  if (d.scale) tags.push('<span class="tag">' + esc(titleCase(d.scale)) + "</span>");
  if (d.duration_min)
    tags.push('<span class="tag">' + esc(d.duration_min) + " min</span>");
  if (d.difficulty)
    tags.push('<span class="tag">' + esc(titleCase(d.difficulty)) + "</span>");
  if (d.lodd_connection)
    tags.push('<span class="tag lodd">LODD lesson</span>');

  return (
    '<a class="card" href="#/drill/' +
    esc(d.id) +
    '">' +
    '<div class="card-id">' +
    esc(d.id) +
    "</div>" +
    '<div class="card-title">' +
    esc(d.title) +
    "</div>" +
    '<p class="card-obj">' +
    esc(d.objective || "") +
    "</p>" +
    '<div class="meta-row">' +
    tags.join("") +
    "</div>" +
    "</a>"
  );
}

// ---- Detail view ----------------------------------------------------------

function listSection(title, items, opts) {
  if (!items || !items.length) return "";
  var cls = (opts && opts.className) || "";
  var lis = items
    .map(function (it) {
      return "<li>" + esc(it) + "</li>";
    })
    .join("");
  return (
    '<section class="section ' +
    cls +
    '"><h2>' +
    esc(title) +
    '</h2><ul class="plain">' +
    lis +
    "</ul></section>"
  );
}

// NOTE: there is deliberately no locked-drill view any more.
//
// This file used to hold renderLockedDrill(), which rendered a promotion-prep
// drill as a title-and-objective preview when the user was not entitled. It is
// gone because no drill is gated: all 87 are free, unabridged, including the
// promotion-prep study material and the specialty categories. A drill can no
// longer be withheld, so nothing needs to render one half-shown — which also
// retires the "never render a partial drill" hazard for drills entirely. The
// only thing that can be locked now is assembled material, and that has its own
// preview path in lockedPackBody().

function renderDetail(id) {
  var d = drillById(id);
  if (!d) {
    view.innerHTML =
      '<a class="back" href="#/">← All drills</a>' +
      '<p class="error">Drill “' +
      esc(id) +
      '” was not found in the published library.</p>';
    focusMain();
    return;
  }

  var html = "";
  html += '<a class="back" href="#/">← All drills</a>';
  html += '<article class="detail">';
  html += '<div class="card-id">' + esc(d.id) + "</div>";
  html += "<h1>" + esc(d.title) + "</h1>";

  var tags = [];
  tags.push('<span class="tag">' + esc(categoryLabel(d.category)) + "</span>");
  if (d.subcategory)
    tags.push('<span class="tag">' + esc(titleCase(d.subcategory)) + "</span>");
  if (d.scale) tags.push('<span class="tag">' + esc(titleCase(d.scale)) + "</span>");
  if (d.difficulty)
    tags.push('<span class="tag">' + esc(titleCase(d.difficulty)) + "</span>");
  if (d.duration_min)
    tags.push('<span class="tag">' + esc(d.duration_min) + " min</span>");
  (d.roles || []).forEach(function (r) {
    tags.push('<span class="tag">' + esc(titleCase(r)) + "</span>");
  });
  html += '<div class="meta-row">' + tags.join("") + "</div>";

  // Objective
  if (d.objective) {
    html +=
      '<section class="section"><h2>Objective</h2><p class="objective">' +
      esc(d.objective) +
      "</p></section>";
  }

  // Equipment + setup
  html += listSection("Equipment", d.equipment);
  if (d.setup) {
    html +=
      '<section class="section"><h2>Setup</h2><p>' + esc(d.setup) + "</p></section>";
  }

  // Material for this drill, if a pack exists. Sits right after setup because
  // that is where the drill tells the user to go and build something.
  html += resourceBanner(d);

  // Steps (numbered)
  if (d.steps && d.steps.length) {
    var steps = d.steps
      .map(function (s) {
        return "<li>" + esc(s) + "</li>";
      })
      .join("");
    html +=
      '<section class="section"><h2>Run the drill</h2><ol class="steps">' +
      steps +
      "</ol></section>";
  }

  html += listSection("Success criteria", d.success_criteria);
  html += listSection("Teaching points", d.learning_points);
  html += listSection("Common mistakes", d.common_mistakes);

  // Safety — visually emphasized
  if (d.safety_notes && d.safety_notes.length) {
    var notes = d.safety_notes
      .map(function (n) {
        return "<li>" + esc(n) + "</li>";
      })
      .join("");
    html +=
      '<section class="section callout safety"><h2>Safety</h2><ul class="plain">' +
      notes +
      "</ul></section>";
  }

  // Variations
  if (d.variations && d.variations.length) {
    var vars = d.variations
      .map(function (v) {
        return (
          '<div class="variation"><h3>' +
          esc(v.name || "Variation") +
          "</h3>" +
          (v.description ? "<p>" + esc(v.description) + "</p>" : "") +
          (v.adds ? '<p class="adds">Adds: ' + esc(v.adds) + "</p>" : "") +
          "</div>"
        );
      })
      .join("");
    html +=
      '<section class="section"><h2>Variations</h2>' + vars + "</section>";
  }

  // Solo variant — how to run this alone.
  //
  // This has to be here, and near the top of the reading order, because the
  // plan view tells a solo user "use the solo variant" and sends them to this
  // page. Without it they land on a crew drill telling them what Firefighter 2
  // does, with no way to run it — the recommendation becomes a dead end.
  if (d.solo_variant) {
    var sv = d.solo_variant;
    html += '<section class="section callout solo-variant"><h2>Training alone</h2>';
    html += "<p><strong>What stands in for the others.</strong> " + esc(sv.substitutions) + "</p>";
    html += "<h3>Run it solo</h3><ol class=\"steps\">";
    (sv.steps || []).forEach(function (s) {
      html += "<li>" + esc(s) + "</li>";
    });
    html += "</ol>";
    html += "<h3>Score yourself</h3><p>" + esc(sv.self_score) + "</p>";
    // Never let a solo user believe they trained something they did not.
    html += '<h3>What this does not cover</h3><p class="not-covered">' + esc(sv.not_covered) + "</p>";
    html += "</section>";
  }

  // LODD connection — honor lessons learned
  if (d.lodd_connection) {
    var l = d.lodd_connection;
    html += '<section class="section callout lodd"><h2>Line-of-duty lesson</h2>';
    if (l.incident) html += "<p>" + esc(l.incident) + "</p>";
    if (l.lesson) html += '<p class="lodd-lesson">' + esc(l.lesson) + "</p>";
    html += "</section>";
  }

  // References
  if (d.references && d.references.length) {
    html +=
      '<section class="section"><h2>References</h2><ul class="plain refs">' +
      d.references
        .map(function (r) {
          return "<li>" + esc(r) + "</li>";
        })
        .join("") +
      "</ul></section>";
  }

  // Tailboard — the reflect step. Sits at the end because you fill it in after
  // running the drill, not before.
  html += drillReflectBlock(d);

  // Report a problem with THIS drill. The drill id and title go into the
  // subject line, so a report arrives already saying what it is about — a
  // firefighter who spots a wrong distance or an unsafe step should not also
  // have to explain which of 67 drills they were reading.
  //
  // This is the only outbound channel in the app, and it is deliberately a
  // mailto: no form, no endpoint, nothing collected. The user's mail client
  // shows them exactly what they are sending before they send it.
  html +=
    '<p class="report-drill"><a href="mailto:grant@sirenstosyntax.com' +
    "?subject=" +
    encodeURIComponent("DrillGround — " + d.id + ": " + (d.title || "")) +
    "&body=" +
    encodeURIComponent(
      "What looks wrong with this drill?\n\n\n" +
        "---\n" +
        d.id +
        " — " +
        (d.title || "") +
        "\n"
    ) +
    '">Something wrong with this drill? Tell me</a></p>';

  html += "</article>";
  view.innerHTML = html;
  wireDrillReflect();
  focusMain();
}

function focusMain() {
  window.scrollTo(0, 0);
  var main = document.getElementById("main");
  if (main) main.focus();
}

// ---- Routing --------------------------------------------------------------

function router() {
  if (!state.library) return;
  var hash = window.location.hash || "#/";
  var m = hash.match(/^#\/drill\/(.+)$/);
  var r = hash.match(/^#\/resources\/(.+)$/);
  if (m) {
    renderDetail(decodeURIComponent(m[1]));
  } else if (r) {
    renderResourcePack(decodeURIComponent(r[1]));
  } else if (hash === "#/resources") {
    renderResources();
  } else if (hash === "#/assess") {
    renderAssess();
  } else if (hash === "#/plan") {
    renderPlan();
  } else if (hash === "#/tailboard") {
    renderTailboard();
  } else if (hash === "#/tailboard/call") {
    renderCallLog();
  } else if (hash === "#/promotion") {
    renderPromotion();
  } else {
    renderList();
  }
  window.scrollTo(0, 0);
}

// ---- Boot -----------------------------------------------------------------

function boot() {
  fetch(DATA_URL, { cache: "no-cache" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (lib) {
      state.library = lib;
      (lib.categories || []).forEach(function (c) {
        state.categoryNames[c.id] = c.name;
      });
      state.assessment = loadAssessment();
      state.tailboard = loadTailboard();
      try {
        state.entitlements = entitlements().parseEntitlements(
          window.localStorage.getItem(entitlements().STORAGE_KEY)
        );
      } catch (e) { state.entitlements = {}; }
      var count = (lib.drills || []).length;
      footerNote.textContent =
        "DrillGround · " +
        count +
        " published drills" +
        (lib.meta && lib.meta.version ? " · library v" + lib.meta.version : "");
      if (lib.meta && lib.meta.disclaimer) {
        disclaimerEl.textContent = lib.meta.disclaimer;
      }
      router();
      // Resource packs load AFTER the first render, on purpose. They are
      // supporting material: the drills must be browsable the instant the
      // library lands, and a slow or missing resource file must never delay or
      // break that. Each resolution re-runs the router so the material appears
      // when it arrives. Previews and cached packs paint once the store is
      // known, before Play acknowledge and the price lookup.
      bootPurchases();
    })
    .catch(function (err) {
      view.innerHTML =
        '<p class="error">Could not load the drill library (' +
        esc(err.message) +
        "). If you opened this file directly, run <code>npm run app</code> and open the address it prints.</p>";
      footerNote.textContent = "Drill library failed to load.";
    });
}

function bootPurchases() {
  var P = purchases();
  if (!P || typeof P.createPurchases !== "function") {
    state.storeAvailable = false;
    return Promise.resolve(false);
  }
  var onUnlock = function () {
    // Restore grants the unlock before acknowledge and the price lookup.
    // Start the packs load now. packsLoad coalesces a later call, so the
    // catalog path does not send a second POST. A catalog response that
    // arrives after paid bodies keeps those bodies and adds the catalog's
    // free packs and previews.
    try {
      state.entitlements = entitlements().parseEntitlements(
        window.localStorage.getItem(entitlements().STORAGE_KEY)
      );
    } catch (e) {
      state.entitlements.support_packs = true;
    }
    if (packsSurfaceOpen()) {
      state.packsLoading = true;
      loadUnlockedResources("support_packs");
    }
  };
  var onRevoke = function () {
    state.servedPackCount = null;
    state.paidDeliveryOk = false;
    state.purchaseRevoked = true;
    state.purchaseMessage = PLAY_NO_LONGER_LISTS;
    if (state.resourceCatalog) state.resources = state.resourceCatalog;
    try {
      state.entitlements = entitlements().parseEntitlements(
        window.localStorage.getItem(entitlements().STORAGE_KEY)
      );
    } catch (e) {
      state.entitlements = {};
    }
  };
  try {
    state.entitlements = entitlements().parseEntitlements(
      window.localStorage.getItem(entitlements().STORAGE_KEY)
    );
  } catch (e) {
    state.entitlements = {};
  }
  var purchaseDeps = P.browserDeps(entitlements(), onUnlock, onRevoke);
  state.purchase = P.createPurchases(purchaseDeps);
  // After the purchase object exists. onRevoke itself does not paint;
  // a late packs response does, because the timeout paint already ran.
  purchaseDeps.onLatePacks = function (result, requestId) {
    acceptPackResult(result, requestId);
    try {
      router();
    } catch (e) {}
  };
  purchaseDeps.onCachedPacks = function (result, requestId) {
    acceptPackResult(result, requestId);
    try {
      router();
    } catch (e) {}
  };
  return state.purchase
    .available()
    .then(function (ok) {
      state.storeAvailable = !!ok;
      if (!ok) return false;
      var painted = loadResources();
      return state.purchase.restore().then(function () {
        try {
          state.entitlements = entitlements().parseEntitlements(
            window.localStorage.getItem(entitlements().STORAGE_KEY)
          );
        } catch (e) {}
        return state.purchase.detailsFor("support_packs").then(function (details) {
          state.purchasePrice = formatStorePrice(details);
          try { router(); } catch (e) {}
          return painted;
        });
      });
    })
    .catch(function () {
      state.storeAvailable = false;
      return false;
    });
}

// Resource packs. The public catalog is free-only and is never used as a
// pack storefront. Inside the TWA the store catalog (paid previews) loads.
// Paid bodies come from POST /api/packs after listPurchases returns a token.
// An ordinary browser skips the catalog entirely. The free drill library
// does not use this path.
function loadResources() {
  if (!packsSurfaceOpen()) {
    state.resources = {};
    state.resourcesReady = true;
    return Promise.resolve();
  }
  function paint() {
    try {
      router();
    } catch (e) {}
  }
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var catalogMs = typeof state.storeCatalogTimeoutMs === "number" ? state.storeCatalogTimeoutMs : 8000;
  var timer = null;
  var timed = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () {
      if (controller) {
        try { controller.abort(); } catch (e) {}
      }
      reject(new Error("timeout"));
    }, catalogMs);
  });
  var init = { cache: "no-cache" };
  if (controller) init.signal = controller.signal;
  return Promise.race([
    fetch(STORE_RESOURCES_URL, init),
    timed,
  ]).then(function (res) {
    clearTimeout(timer);
    timer = null;
    if (!res.ok) throw new Error("HTTP " + res.status);
    var body = new Promise(function (_resolve, reject) {
      timer = setTimeout(function () {
        if (controller) {
          try { controller.abort(); } catch (e) {}
        }
        reject(new Error("timeout"));
      }, catalogMs);
    });
    return Promise.race([res.json(), body]).then(function (catalog) {
      clearTimeout(timer);
      return catalog;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }, function (err) {
    clearTimeout(timer);
    throw err;
  })
    .then(function (catalog) {
      state.resourceCatalog = resources().indexPacks(catalog);
      if (state.paidDeliveryOk && state.resources) {
        state.resources = resources().mergeCatalogUnderPaid(state.resourceCatalog, state.resources);
      } else {
        state.resources = state.resourceCatalog;
      }
      state.resourcesReady = true;
      // Previews paint before listPurchases and POST /api/packs. A throw
      // here must not fall through to the catalog-failure handler, which
      // would load the packs again.
      if (resourcesEntitled("support_packs") && !packsLoad && !state.paidDeliveryOk) {
        state.packsLoading = true;
      }
      paint();
      return startPacksAfterCatalog(paint);
    })
    .catch(function () {
      // The store catalog is the preview list. An owner's cached paid
      // packs still have to appear when that fetch fails, including offline.
      clearTimeout(timer);
      state.resourcesReady = true;
      if (!state.resources) state.resources = {};
      if (resourcesEntitled("support_packs") && !packsLoad && !state.paidDeliveryOk) {
        state.packsLoading = true;
      }
      paint();
      return startPacksAfterCatalog(paint);
    });
}

function startPacksAfterCatalog(paint) {
  if (!resourcesEntitled("support_packs")) return;
  if (packsLoad || state.paidDeliveryOk) return;
  state.packsLoading = true;
  return Promise.resolve(loadUnlockedResources("support_packs")).then(paint, paint);
}

// Latest applied network success and latest applied revoke, tracked apart
// from plain failures the same way purchase.js stillCurrent does. An older
// result is dropped only when a newer success or a newer revoke has
// been applied. A cache fallback is not that success: it must not move
// succeededPackRequest, or the older request's fresh body is dropped.
// A newer timeout, rate limit, or other plain failure does not drop a
// late success. That failure says the packs are still showing only when
// paid content is actually on screen. A revoke replaces that sentence.
var succeededPackRequest = 0;
var gonePackRequest = 0;
var PACKS_STILL_SHOWING = "We're still showing your packs.";
var PACKS_STILL_LOADING = "Still loading your packs…";
var PLAY_NO_LONGER_LISTS = "Play no longer lists this purchase.";

function paidPacksVisible() {
  if (state.paidDeliveryOk !== true) return false;
  if (!(typeof state.servedPackCount === "number" && state.servedPackCount > 0)) return false;
  var index = state.resources;
  if (!index || typeof index !== "object") return false;
  var ids = Object.keys(index);
  for (var i = 0; i < ids.length; i++) {
    var pack = index[ids[i]];
    if (!pack || pack.tier !== "paid") continue;
    if (Array.isArray(pack.components) && pack.components.length > 0) return true;
  }
  return false;
}

function acceptPackResult(result, requestId) {
  var id = typeof requestId === "number" ? requestId : 0;
  var fromCache = !!(result && result.fromCache);
  var success = !!(result && result.ok && !fromCache);
  var revoke = !!(result && result.reason === "purchase-revoked");
  if (id > 0 && (succeededPackRequest > id || gonePackRequest > id)) return false;
  if (result && result.reason === "purchase-pending") {
    if (result.ok && Array.isArray(result.packs)) {
      applyPaidDelivery({
        ok: true,
        packCount: result.packCount,
        packs: result.packs,
      });
    }
    state.purchaseMessage = "Play has not confirmed this purchase yet.";
    if (!paidPacksVisible()) {
      state.paidDeliveryOk = false;
      state.paidDeliveryReason = "purchase-pending";
      return "pending";
    }
    return true;
  }
  if ((!result || !result.ok) && !revoke && paidPacksVisible()) {
    state.purchaseMessage = PACKS_STILL_SHOWING;
    return true;
  }
  var ok = applyPaidDelivery(result);
  if (success && id > succeededPackRequest) succeededPackRequest = id;
  if (revoke && id > gonePackRequest) gonePackRequest = id;
  if (success) state.purchaseMessage = "";
  return ok;
}
// One packs request at a time. A second tap shares this promise.
var packsLoad = null;

function applyPaidDelivery(result) {
  if (!result || !result.ok) {
    state.paidDeliveryOk = false;
    state.paidDeliveryReason = result && result.reason;
    if (result && result.reason === "purchase-revoked") {
      state.servedPackCount = null;
      state.purchaseRevoked = true;
      state.purchaseMessage = PLAY_NO_LONGER_LISTS;
      if (state.resourceCatalog) state.resources = state.resourceCatalog;
      try {
        state.entitlements = entitlements().parseEntitlements(
          window.localStorage.getItem(entitlements().STORAGE_KEY)
        );
      } catch (e) {
        state.entitlements = {};
      }
    }
    return false;
  }
  state.servedPackCount = result.packCount;
  state.paidDeliveryOk = true;
  state.paidDeliveryReason = null;
  state.purchaseRevoked = false;
  state.resources = resources().applyUnlocked(state.resources, { packs: result.packs });
  return true;
}

function loadUnlockedResources(area) {
  if (area && area !== "support_packs") return Promise.resolve(false);
  if (!state.purchase || typeof state.purchase.loadPaidPacks !== "function") {
    state.packsLoading = false;
    return Promise.resolve(false);
  }
  var pending = typeof state.purchase.packsRequestPending === "function" && state.purchase.packsRequestPending();
  if (packsLoad && !pending) return packsLoad;
  if (pending) {
    state.purchaseMessage = PACKS_STILL_LOADING;
    try {
      router();
    } catch (e) {}
  }
  state.packsLoading = true;
  var load = state.purchase
    .loadPaidPacks()
    .then(function (result) {
      var requestId = result && typeof result.requestId === "number" ? result.requestId : 0;
      // A failure is not an empty delivery. paidDeliveryOk stays false, so
      // the bar says try again. invalid-token does not revoke. The caller
      // paints once after this returns. applyUnlocked returns a new index,
      // so a partial fetch cannot leave the app holding half-upgraded state.
      // An older result is dropped only when a newer success or revoke
      // has been applied. A newer plain failure does not throw a success away.
      return acceptPackResult(result, requestId);
    })
    .catch(function (err) {
      // A throw during an existing delivery keeps the packs on screen
      // and keeps the old reason. It does not replace paidDeliveryReason.
      if (paidPacksVisible()) {
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error("Pack load failed during an existing delivery", err);
        }
        state.purchaseMessage = PACKS_STILL_SHOWING;
        return true;
      }
      state.paidDeliveryOk = false;
      state.paidDeliveryReason = "packs-failed";
      return false;
    })
    .then(function (ok) {
      if (packsLoad === load) {
        packsLoad = null;
        state.packsLoading = false;
      }
      return ok;
    });
  packsLoad = load;
  return load;
}

window.addEventListener("hashchange", router);
boot();
