"use strict";

// Turns a firefighter's self-assessment into a ranked list of drills, with a
// stated reason for every one.
//
// This is the "recommendation engine" the vision names as the product's spine:
// it answers "what should I work on?", which the app currently does not answer
// at all — it shows a list and lets the user guess.
//
// Pure by design. No DOM, no storage, no fetch. The UI will change; how a
// weakness becomes a recommendation should not, and it needs to be testable
// without a browser.
//
// Design: products/drillground/docs/self-assessment-design.md

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

// A four-way honest answer beats a 1-5 slider: nobody agrees what 3 means, and
// a vague scale invites a flattering answer. These fuse recency and confidence,
// the two things a firefighter can actually judge about themselves.
const RATINGS = ["untrained", "shaky", "rusty", "solid"];

// `skip` is not a rating — it removes the category. A volunteer with no hazmat
// scope should not be told their hazmat is weak. The vision is explicit that
// the user always chooses freely.
const SKIP = "skip";

const RATING_WEIGHT = { untrained: 4, shaky: 3, rusty: 2, solid: 1 };

// Difficulty matched to the stated level, so a shaky user is not handed an
// advanced drill and a solid one is not handed a review.
const RATING_DIFFICULTY = {
  untrained: "fundamental",
  shaky: "fundamental",
  rusty: "intermediate",
  solid: "advanced",
};

// Consequence tier breaks ties between equal weaknesses. This is an editorial
// judgment, NOT a standards claim — DrillGround does not certify compliance and
// cites no licensed standard for this ordering. The reasoning is that where a
// firefighter is equally weak in two areas, the one that kills them first comes
// first, and this product's user is the individual firefighter rather than a
// department: these are the skills that save the user's own life.
const CONSEQUENCE_TIER = {
  scba_survival: 3,
  rit_mayday: 3,
  lodd_scenarios: 3,
  company_officer: 2,
  engine_company: 2,
  truck_company: 2,
  driver_engineer: 2,
  technical_rescue: 1,
  hazmat: 1,
  multi_company: 1,
};

// Specialty categories. These assume a technician-level scope most firefighters
// do not have, so they are NOT part of the default assessment — the user opts
// in. Telling someone their trench rescue is weak when their department does
// not do trench rescue is noise at best, and at worst it pushes them toward
// training they are not authorized to run alone.
//
// Enforced here rather than only in the UI so that a stored assessment carrying
// an old rating cannot quietly resurface these later.
//
// Caveat worth revisiting: a few drills in these categories are pitched at
// operations level rather than technician (HZM-003 addresses "an operations-
// level responder" directly). Opting out currently loses those too. The finer
// split would be per-drill, not per-category.
const OPT_IN_CATEGORIES = ["technical_rescue", "hazmat"];

const CORE_CATEGORIES = [
  "scba_survival",
  "rit_mayday",
  "lodd_scenarios",
  "engine_company",
  "truck_company",
  "company_officer",
  "driver_engineer",
  "multi_company",
];

function isOptIn(category) {
  return OPT_IN_CATEGORIES.indexOf(category) !== -1;
}

const STAFFING = ["solo", "partner", "crew"];

// Which kind of activity the user is asking for. An oral-board tabletop and a
// hoseline evolution are structurally identical records and completely
// different activities — mixing them means someone who said "I am on my own
// with 45 minutes" gets handed a scenario needing a facilitator and two
// role-players.
//
// "drills" is the default and excludes study material entirely. Promotion prep
// is opt-in, the same way the specialty categories are.
const TRACKS = ["drills", "promotion"];

function drillProductMode(drill) {
  return drill.product_mode || "drill_generation";
}

function fitsTrack(drill, track) {
  const mode = drillProductMode(drill);
  if (track === "promotion") return mode === "promotion_prep";
  return mode === "drill_generation";
}

// A drill is reachable solo if one firefighter can run it as written, or if it
// carries a reviewed solo_variant. Both come from the solo classification work.
function isSoloCapable(drill) {
  return drill.solo_runnable === true || isPlainObject(drill.solo_variant);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function fitsStaffing(drill, staffing) {
  if (staffing === "solo") return isSoloCapable(drill);
  if (staffing === "partner") {
    // A pair can run anything a lone firefighter can, plus pair-scale work.
    return isSoloCapable(drill) || drill.scale === "individual" || drill.scale === "pair";
  }
  return true; // a crew can run anything
}

function fitsTime(drill, minutes) {
  if (!minutes) return true;
  return typeof drill.duration_min !== "number" || drill.duration_min <= minutes;
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {Array}  input.drills      published drills
 * @param {object} input.ratings     { category_id: rating|"skip" }
 * @param {object} [input.context]   { staffing, minutes, track }
 * @param {Array}  [input.recentDrillIds] drills logged in Tailboard lately, deprioritised
 * @param {number} [input.limit]     max recommendations (default 5)
 * @param {object} [input.categoryNames] { id: display name } for reason text
 * @returns {{recommendations: Array, assessed: number, skipped: number}}
 */
function recommendDrills(input) {
  const opts = input || {};
  const drills = Array.isArray(opts.drills) ? opts.drills : [];
  const ratings = isPlainObject(opts.ratings) ? opts.ratings : {};
  const context = isPlainObject(opts.context) ? opts.context : {};
  const names = isPlainObject(opts.categoryNames) ? opts.categoryNames : {};
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : 5;

  const staffing = STAFFING.indexOf(context.staffing) !== -1 ? context.staffing : "crew";
  const track = TRACKS.indexOf(context.track) !== -1 ? context.track : "drills";
  const minutes = typeof context.minutes === "number" ? context.minutes : 0;

  const optedIn = Array.isArray(opts.optedIn) ? opts.optedIn : [];
  // Drill ids the user recently logged a Tailboard reflection against.
  const recentDrillIds = Array.isArray(opts.recentDrillIds) ? opts.recentDrillIds : [];

  let assessed = 0;
  let skipped = 0;

  // Rank categories by weakness, then by consequence.
  const ranked = [];
  for (const category of Object.keys(ratings)) {
    const rating = ratings[category];
    if (rating === SKIP) {
      skipped++;
      continue;
    }
    if (RATINGS.indexOf(rating) === -1) continue; // ignore unknown values
    // A specialty category counts only if the user explicitly opted in, even if
    // a rating for it is sitting in storage from before.
    if (isOptIn(category) && optedIn.indexOf(category) === -1) continue;
    assessed++;
    ranked.push({
      category: category,
      rating: rating,
      weight: RATING_WEIGHT[rating],
      tier: CONSEQUENCE_TIER[category] || 1,
    });
  }

  ranked.sort(function (a, b) {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.tier !== a.tier) return b.tier - a.tier;
    return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
  });

  // One drill per category before a second from any category — a user weak in
  // four areas wants a spread, not four engine drills.
  const recommendations = [];
  const usedDrillIds = {};
  let round = 0;

  while (recommendations.length < limit && round < 3) {
    let addedThisRound = 0;

    for (const entry of ranked) {
      if (recommendations.length >= limit) break;

      const wanted = RATING_DIFFICULTY[entry.rating];
      let pool = drills.filter(function (d) {
        return (
          d.category === entry.category &&
          !usedDrillIds[d.id] &&
          fitsTrack(d, track) &&
          fitsStaffing(d, staffing) &&
          fitsTime(d, minutes)
        );
      });

      // Drills the user logged in Tailboard recently. Skipped so the app does
      // not hand back the same drill two days running.
      //
      // Deliberately drill-level, never category-level: having trained mayday
      // once does not mean mayday has stopped being your weakest area, and
      // demoting the category here would walk users away from their weaknesses.
      if (recentDrillIds.length) {
        const fresh = pool.filter((d) => recentDrillIds.indexOf(d.id) === -1);
        // Only apply it if something is left. A user who has worked through
        // everything in a category should get a repeat, not an empty plan.
        if (fresh.length) pool = fresh;
      }

      if (pool.length === 0) continue;

      // Prefer the matched difficulty; fall back rather than recommend nothing,
      // and say so in the reason so the user is not misled about the fit.
      let picked = pool.filter((d) => d.difficulty === wanted)[0];
      let difficultyMatched = true;
      if (!picked) {
        picked = pool[0];
        difficultyMatched = false;
      }

      usedDrillIds[picked.id] = true;
      addedThisRound++;
      recommendations.push({
        drill: picked,
        category: entry.category,
        rating: entry.rating,
        score: entry.weight * 10 + entry.tier,
        difficultyMatched: difficultyMatched,
        reasons: buildReasons(entry, picked, staffing, minutes, difficultyMatched, names),
      });
    }

    if (addedThisRound === 0) break; // nothing left to offer
    round++;
  }

  return { recommendations: recommendations, assessed: assessed, skipped: skipped };
}

// A recommendation the user cannot interrogate is an instruction, and this
// product is advisory. Every pick says why it was picked.
function buildReasons(entry, drill, staffing, minutes, difficultyMatched, names) {
  const label = names[entry.category] || entry.category;
  const reasons = [];

  if (entry.rating === "untrained") {
    reasons.push("You said you have never really trained " + label + ".");
  } else if (entry.rating === "shaky") {
    reasons.push("You said you would hesitate on " + label + ".");
  } else if (entry.rating === "rusty") {
    reasons.push("You said " + label + " has been a while.");
  } else {
    reasons.push("You back yourself on " + label + " — this one is a stretch.");
  }

  if (difficultyMatched) {
    reasons.push("Pitched at " + drill.difficulty + " level to match.");
  } else {
    reasons.push(
      "No " +
        RATING_DIFFICULTY[entry.rating] +
        " drill was available here, so this is " +
        drill.difficulty +
        "."
    );
  }

  if (staffing === "solo") {
    reasons.push(
      drill.solo_runnable === true
        ? "You can run this alone as written."
        : "You are on your own — use the solo variant."
    );
  }

  if (minutes && typeof drill.duration_min === "number") {
    reasons.push("Fits the " + minutes + " minutes you have (" + drill.duration_min + " min).");
  }

  return reasons;
}

// Loaded two ways: `require`d by the Node tests, and as a plain <script> by the
// app, which has no module system. Same file either way — the scoring rules a
// firefighter sees must be the ones the tests actually cover.
const API = {
  recommendDrills,
  RATINGS,
  SKIP,
  RATING_WEIGHT,
  RATING_DIFFICULTY,
  CONSEQUENCE_TIER,
  CORE_CATEGORIES,
  OPT_IN_CATEGORIES,
  STAFFING,
  TRACKS,
  isOptIn,
  fitsTrack,
  isSoloCapable,
};

if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundRecommend = API;
}
