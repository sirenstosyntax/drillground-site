"use strict";

// IMPORTANT: the whole module is wrapped in an IIFE.
//
// The app loads these as classic <script> tags, which share ONE global lexical
// scope — so a top-level `const` here would collide with the same name in
// another module and the second file would die silently before defining
// anything. See tailboard.js for the full story.
(function () {
"use strict";

// Training reminders — deciding WHAT to say and WHEN, and nothing else.
//
// This exists for the iOS build (docs/app-store-distribution-plan.md, Track B).
// Apple rejects apps that are "not sufficiently different from a web browsing
// experience", and a local notification is something iOS Safari genuinely
// cannot do — so it is both the strongest answer to that policy and a feature
// worth having on its own.
//
// PURE BY DESIGN, like recommend-drills.js and tailboard.js: no DOM, no
// storage, no fetch, and no notification API. It returns a plain description of
// a reminder; the platform shell schedules it. That is what lets this be tested
// without a device, and it is why Android can reuse it later without a rewrite.
//
// THE VOICE IS THE APP'S OWN. A reminder says the same thing the plan screen
// says — "You said you would hesitate on X" — because the recommendation engine
// already wrote that sentence and a notification that invents its own tone
// reads like marketing. Reminders quote `recommendDrills`; they never reason
// about the library themselves.
//
// WHAT IT WILL NOT DO, deliberately:
//
//   - Nag. Three unanswered reminders and it stops. A firefighter who is not
//     training does not need a fourth notification about it; they need the app
//     to be there when they come back.
//   - Interrupt someone who is already training. A Tailboard entry inside the
//     quiet window means the reminder has nothing to add.
//   - Guess. No assessment means no honest sentence to send, so it sends
//     nothing rather than something generic.
//   - Leave the device. The text is composed here, on-device, from data that
//     never transmits. There is no server in this feature and there must not be.

// How long after the last sign of training before a reminder is due.
var CADENCE_DAYS = 7;

// A Tailboard entry inside this window means they are training now.
var QUIET_DAYS = 7;

// Unanswered reminders before this gives up. "Unanswered" means sent with no
// Tailboard entry after it.
var MAX_UNANSWERED = 3;

// Local hour to fire at. Late morning: after a shift change, before a busy
// afternoon, and never in the middle of the night for someone on nights.
var DEFAULT_HOUR = 10;

var DAY_MS = 24 * 60 * 60 * 1000;

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function toTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    var t = Date.parse(value);
    return isNaN(t) ? null : t;
  }
  return null;
}

/** Most recent Tailboard entry time, or null if there are none. */
function lastEntryAt(entries) {
  var latest = null;
  for (var i = 0; i < (entries || []).length; i++) {
    var t = toTime(entries[i] && entries[i].at);
    if (t !== null && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

/**
 * How many reminders have been sent with no Tailboard entry after them.
 *
 * `sentAt` is a list of times the shell actually delivered a reminder — the
 * shell owns that record because only it knows what the OS did with them.
 */
function unansweredCount(sentAt, entries) {
  var last = lastEntryAt(entries);
  var n = 0;
  for (var i = 0; i < (sentAt || []).length; i++) {
    var t = toTime(sentAt[i]);
    if (t === null) continue;
    if (last === null || t > last) n++;
  }
  return n;
}

/** The next local `hour` at or after `from`, as a timestamp. */
function nextAtHour(from, hour) {
  var d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() < from) d.setTime(d.getTime() + DAY_MS);
  return d.getTime();
}

/**
 * Decide the next reminder, or null for "say nothing".
 *
 * @param {Object} input
 * @param {Function} input.recommend  recommendDrills, injected so this module
 *                                    stays pure and the engine stays the one
 *                                    place that reasons about the library
 * @param {Array}  input.drills       published library
 * @param {Object} input.ratings      the self-assessment
 * @param {Array}  [input.optedIn]    specialty categories opted into
 * @param {Object} [input.context]    staffing / minutes / track
 * @param {Object} [input.categoryNames] id -> human label
 * @param {Array}  [input.entries]    Tailboard entries
 * @param {Array}  [input.sentAt]     times reminders were delivered
 * @param {number} [input.assessedAt] when the assessment was completed
 * @param {number|Date|string} input.now
 * @param {number} [input.hour]
 * @returns {{at:number, title:string, body:string, drillId:string, category:string}|null}
 */
function nextReminder(input) {
  var opts = isPlainObject(input) ? input : {};
  var now = toTime(opts.now);
  if (now === null) return null;

  var ratings = isPlainObject(opts.ratings) ? opts.ratings : {};
  // No assessment, nothing honest to say. This is the common case for a user
  // who installed the app and has not started, and they get silence.
  if (Object.keys(ratings).length === 0) return null;

  var entries = Array.isArray(opts.entries) ? opts.entries : [];
  var last = lastEntryAt(entries);

  // Already training. A reminder would be telling them something they know.
  if (last !== null && now - last < QUIET_DAYS * DAY_MS) return null;

  // Give up rather than nag.
  if (unansweredCount(opts.sentAt, entries) >= MAX_UNANSWERED) return null;

  // Due from the last sign of life: a reflection if there is one, otherwise the
  // assessment itself.
  var since = last !== null ? last : toTime(opts.assessedAt);
  if (since === null) since = now;
  var due = since + CADENCE_DAYS * DAY_MS;
  if (due > now) return null;

  var recommend = typeof opts.recommend === "function" ? opts.recommend : null;
  if (!recommend) return null;

  var result = recommend({
    drills: Array.isArray(opts.drills) ? opts.drills : [],
    ratings: ratings,
    optedIn: Array.isArray(opts.optedIn) ? opts.optedIn : [],
    context: isPlainObject(opts.context) ? opts.context : {},
    categoryNames: isPlainObject(opts.categoryNames) ? opts.categoryNames : {},
    limit: 1,
  });

  var top = result && result.recommendations && result.recommendations[0];
  // The engine can legitimately return nothing — everything rated solid, or a
  // context that filters the library empty. Silence is the right answer.
  if (!top || !top.drill) return null;

  // The reason the plan screen would show, verbatim. If the engine gave none,
  // fall back to the drill's own title rather than inventing a justification.
  var reason = Array.isArray(top.reasons) && top.reasons.length ? top.reasons[0] : "";

  return {
    at: nextAtHour(now, typeof opts.hour === "number" ? opts.hour : DEFAULT_HOUR),
    title: "Train this week",
    body: reason ? reason + " Try " + top.drill.title + "." : "Try " + top.drill.title + ".",
    drillId: top.drill.id,
    category: top.drill.category,
  };
}

var API = {
  CADENCE_DAYS: CADENCE_DAYS,
  QUIET_DAYS: QUIET_DAYS,
  MAX_UNANSWERED: MAX_UNANSWERED,
  DEFAULT_HOUR: DEFAULT_HOUR,
  lastEntryAt: lastEntryAt,
  unansweredCount: unansweredCount,
  nextReminder: nextReminder,
};

if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundReminders = API;
}

})();
