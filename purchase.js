"use strict";

// IMPORTANT: the whole module is wrapped in an IIFE.
//
// The app loads these as classic <script> tags, which share ONE global lexical
// scope — so a top-level `const` here would collide with the same name in
// another module and the second file would die silently before defining
// anything. entitlements.js, recommend-drills.js and tailboard.js are wrapped
// the same way; a regression test loads them all into one shared context.
(function () {
"use strict";

// Purchases — turning a Play purchase into the entitlement state that
// entitlements.js already reads.
//
// entitlements.js decides what an entitlement MEANS. This decides how one is
// obtained. The split matters: entitlements.js is pure and has no idea a store
// exists, and nothing here should teach it.
//
// Everything is injected. There is no reference to `window`, `fetch`,
// `localStorage` or PaymentRequest in the logic below — the browser binding at
// the bottom supplies those. That is what lets the whole flow be tested in node
// with no browser and no network, which is the only way any of this gets
// exercised at all: the container cannot build an .aab and CI has no phone.
//
// See engineering/briefs/DRILLGROUND-EB-0210.md.

// The Play payment method. Chrome routes a PaymentRequest naming this to the
// Play Billing code inside the TWA wrapper.
var BILLING_METHOD = "https://play.google.com/billing";

// One Play SKU unlocks every support pack. This string must match the in-app
// product id in Play Console EXACTLY; a typo is a purchase flow that opens
// and then fails with an unhelpful store error. Managed (non-consumable),
// not a subscription. The retired SKUs drillground.resource_packs.v1 and
// drillground.promotion_prep_packs.v1 must not be asked for.
var SUPPORT_PACKS_SKU = "drillground.packs.v1";
var SKUS = {
  support_packs: SUPPORT_PACKS_SKU,
};

function areaForSku(sku) {
  for (var area in SKUS) {
    if (Object.prototype.hasOwnProperty.call(SKUS, area) && SKUS[area] === sku) {
      return area;
    }
  }
  return null;
}

function skuForArea(area) {
  return Object.prototype.hasOwnProperty.call(SKUS, area) ? SKUS[area] : null;
}

// ---------------------------------------------------------------------------
// ACKNOWLEDGEMENT — READ THIS BEFORE CHARGING ANYBODY.
//
// Google Play refunds a purchase that is not acknowledged within three days.
// Nothing in the UI looks wrong while that happens; the money simply reverses.
//
// Verified against source rather than remembered (2026-08-16):
//
//   - Digital Goods API v2.1 (Chrome M102+) exposes getDetails, listPurchases,
//     listPurchaseHistory and consume. It has NO acknowledge(). The v1.0
//     acknowledge(token, purchaseType) was removed in v2.0.
//   - android-browser-helper's ConsumeCall maps consume() to
//     BillingClient.consumeAsync() — which CONSUMES the purchase and makes it
//     buyable again. For a permanent unlock that is precisely wrong: it would
//     revoke the thing the user paid for, and listPurchases() would stop
//     returning it.
//   - android-browser-helper's PaymentActivity does NOT acknowledge on a
//     successful flow. It returns the purchase token and finishes.
//   - Its legacy AcknowledgeCall still exists on the Android side and
//     acknowledges without consuming when makeAvailableAgain is false, but it
//     is documented as "kept around for legacy reasons" and Chrome's v2.1 JS
//     surface does not expose it.
//
// So on a current Chrome there is no verified client-side path to acknowledge a
// NON-CONSUMABLE purchase from the page. Hence:
//
//   1. We never call consume() for these products. Doing so would revoke them.
//   2. We call acknowledge() only if the running browser actually offers it
//      (older Digital Goods surface), which is a real possibility on the wide
//      range of Chrome versions in the field and costs nothing to support.
//   3. When neither exists we do NOT pretend the purchase is settled. The
//      result carries acknowledged:false and a reason, so the caller can log,
//      warn, or refuse to go live.
//
// The page still cannot acknowledge a non-consumable on Digital Goods v2.1.
// The production path is server-side purchases.products.acknowledge (EB-0214
// Option A). The TWA POSTs the purchase token to ACKNOWLEDGE_ENDPOINT; the
// backend verifies and acknowledges. That service is not consume().
//
// ACKNOWLEDGE_ENDPOINT is the same-origin path. GitHub Pages cannot serve it.
// The live page sets window.DRILLGROUND_ACKNOWLEDGE_ENDPOINT to the Cloud Run
// URL (base or full POST path). resolveAcknowledgeUrl accepts either.
//
// Older browsers that still expose service.acknowledge() are used only when
// the server path is missing or failed. Never consume().
// ---------------------------------------------------------------------------
var ACKNOWLEDGE_ENDPOINT = "/api/purchases/acknowledge";
var PACKS_ENDPOINT = "/api/packs";
// Separate from the app-shell cache so a CACHE_VERSION bump can drop the old
// public unlocked file without deleting a purchase the device still holds.
// restore() deletes this whole cache only for a purchase-revoked answer.
var PAID_CACHE_NAME = "drillground-paid-packs";
var PAID_CACHE_URL = "./drillground-paid-packs.json";
var PACKS_NETWORK_TIMEOUT_MS = 8000;
// A first purchase has no cache to paint. Wait longer before the
// no-signal line. A response that arrives after either wait is still
// written to the cache.
var PACKS_NETWORK_TIMEOUT_NO_CACHE_MS = 30000;
// Silence after the headers. Each chunk resets it. A body that never
// sends another byte cannot hold the load open. The idle timer still
// arms after the first-byte deadline, so a late body that stalls is
// aborted. The hard cap starts when the fetch starts, not when the
// body starts, and it aborts even when chunks keep arriving. It is
// not a body-only timer. A purchase at or after the baseline pull is
// served from the staged bundle. The cap is 240s.
var BODY_IDLE_MS = 30000;
var BODY_CAP_MS = 240000;
var ACKNOWLEDGE_ATTEMPTS = 3;

function resolveAcknowledgeUrl(configured) {
  var raw = typeof configured === "string" ? configured.trim() : "";
  if (!raw) return ACKNOWLEDGE_ENDPOINT;
  raw = raw.replace(/\/+$/, "");
  if (raw.slice(-ACKNOWLEDGE_ENDPOINT.length) === ACKNOWLEDGE_ENDPOINT) {
    return raw;
  }
  return raw + ACKNOWLEDGE_ENDPOINT;
}

function resolvePacksUrl(configured, acknowledgeConfigured) {
  var raw = typeof configured === "string" ? configured.trim() : "";
  if (!raw) {
    var ack = resolveAcknowledgeUrl(acknowledgeConfigured);
    if (ack.slice(-ACKNOWLEDGE_ENDPOINT.length) === ACKNOWLEDGE_ENDPOINT) {
      return ack.slice(0, -ACKNOWLEDGE_ENDPOINT.length) + PACKS_ENDPOINT;
    }
    return PACKS_ENDPOINT;
  }
  raw = raw.replace(/\/+$/, "");
  if (raw.slice(-PACKS_ENDPOINT.length) === PACKS_ENDPOINT) return raw;
  return raw + PACKS_ENDPOINT;
}

function sleepMs(deps, ms) {
  if (deps && typeof deps.sleep === "function") return deps.sleep(ms);
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function acknowledgeOnServer(deps, purchaseToken) {
  if (!deps || typeof deps.postAcknowledge !== "function") {
    return Promise.resolve({ acknowledged: false, reason: "no-acknowledge-endpoint" });
  }
  var body = { purchaseToken: purchaseToken, productId: SUPPORT_PACKS_SKU };
  var attempts = 0;
  function once() {
    attempts += 1;
    return Promise.resolve()
      .then(function () {
        return deps.postAcknowledge(body);
      })
      .then(function (res) {
        if (res && res.ok) {
          return {
            acknowledged: true,
            via: "play-developer-api",
            alreadyAcknowledged: !!res.alreadyAcknowledged,
          };
        }
        var transient = !!(res && res.transient);
        if (transient && attempts < ACKNOWLEDGE_ATTEMPTS) {
          return sleepMs(deps, attempts * 200).then(once);
        }
        return {
          acknowledged: false,
          reason: (res && res.error) || "acknowledge-failed",
          error: res && (res.message || res.error),
        };
      })
      .catch(function (err) {
        if (attempts < ACKNOWLEDGE_ATTEMPTS) {
          return sleepMs(deps, attempts * 200).then(once);
        }
        return {
          acknowledged: false,
          reason: "acknowledge-failed",
          error: String((err && err.message) || err),
        };
      });
  }
  return once();
}

function acknowledgeOnClient(service, purchaseToken) {
  if (!service || typeof service.acknowledge !== "function") {
    return Promise.resolve({ acknowledged: false, reason: "no-acknowledge-api" });
  }
  // Older Digital Goods surface. Second arg "onetime" = acknowledge without
  // making the item available again, i.e. keep the unlock.
  return Promise.resolve()
    .then(function () {
      return service.acknowledge(purchaseToken, "onetime");
    })
    .then(function () {
      return { acknowledged: true, via: "acknowledge" };
    })
    .catch(function (err) {
      return {
        acknowledged: false,
        reason: "acknowledge-failed",
        error: String((err && err.message) || err),
      };
    });
}

function acknowledgePurchase(service, purchaseToken, deps) {
  if (!purchaseToken) {
    return Promise.resolve({ acknowledged: false, reason: "no-purchase-token" });
  }
  return acknowledgeOnServer(deps, purchaseToken).then(function (serverAck) {
    if (serverAck.acknowledged) return serverAck;
    return acknowledgeOnClient(service, purchaseToken).then(function (clientAck) {
      if (clientAck.acknowledged) return clientAck;
      if (serverAck.reason === "no-acknowledge-endpoint") return clientAck;
      return serverAck;
    });
  });
}

/**
 * Build the purchase API over injected collaborators.
 *
 * @param {object} deps
 * @param {function} deps.getService   () => Promise<service|null>
 * @param {function} deps.readEntitlements  () => object
 * @param {function} deps.writeEntitlements (object) => void
 * @param {function} deps.startPayment (sku) => Promise<{purchaseToken, complete}>
 * @param {function} [deps.postAcknowledge] ({purchaseToken, productId}) => Promise<object>
 * @param {function} [deps.sleep]      (ms) => Promise<void> — injectable backoff
 * @param {function} [deps.onUnlock]   (area) => void — fetch the paid payload
 * @param {function} [deps.onRevoke]   (area) => void — Play no longer lists it
 * @param {function} [deps.postPacks]  ({purchaseToken}) => Promise<{ok,error,reason,packs,packCount}>
 * @param {function} [deps.readPaidCache]  () => Promise<object|null>
 * @param {function} [deps.writePaidCache] (payload) => Promise<void>
 * @param {function} [deps.clearPaidCache] () => Promise<void>
 * @param {function} [deps.warn]       (message, detail) => void
 */
function createPurchases(deps) {
  var d = deps || {};
  var warn = d.warn || function () {};

  function service() {
    if (typeof d.getService !== "function") return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return d.getService(); })
      .catch(function () {
        // Not being in a TWA is the common case, not an error: the same page is
        // a free website in an ordinary browser tab. Nothing to report.
        return null;
      });
  }

  /** Is a store reachable at all? False in any ordinary browser tab. */
  function available() {
    return service().then(function (s) { return !!s; });
  }

  /**
   * Localised title and price for an area, straight from Play — never a
   * hardcoded number, because the store charges in the user's currency and the
   * page has no idea what that is.
   */
  function detailsFor(area) {
    var sku = skuForArea(area);
    if (!sku) return Promise.resolve(null);
    return withTimeout(service().then(function (s) {
      if (!s || typeof s.getDetails !== "function") return null;
      return Promise.resolve()
        .then(function () { return s.getDetails([sku]); })
        .then(function (items) {
          var found = (items || []).filter(function (i) { return i && i.itemId === sku; });
          return found.length ? found[0] : null;
        });
    }), restoreTimeoutMs()).catch(function () { return null; });
  }

  function grant(area) {
    var key = area === "support_packs" ? "support_packs" : area;
    // One SKU grants the one unlock. Ignore retired area names as purchase
    // targets; restore/buy only write support_packs.
    if (key !== "support_packs") return false;
    var stored = d.readEntitlements ? d.readEntitlements() : {};
    var next = {};
    for (var k in stored) {
      if (Object.prototype.hasOwnProperty.call(stored, k)) next[k] = stored[k];
    }
    if (next.support_packs === true) return false; // already held; nothing to write
    next.support_packs = true;
    if (d.writeEntitlements) d.writeEntitlements(next);
    if (d.onUnlock) d.onUnlock("support_packs");
    return true;
  }

  var packsRequestSeq = 0;
  var goneRequestId = 0;
  var succeededRequestId = 0;
  // Last token Play listed this session. A later list that omits the SKU
  // re-checks this token. Only purchase-revoked from that check clears
  // the unlock.
  var lastPurchaseToken = null;
  function markOwnershipGone(requestId) {
    var id = typeof requestId === "number" ? requestId : packsRequestSeq + 1;
    if (id > goneRequestId) goneRequestId = id;
  }

  function networkTimeoutMs(hasCache) {
    if (hasCache) {
      return typeof d.packsTimeoutMs === "number" ? d.packsTimeoutMs : PACKS_NETWORK_TIMEOUT_MS;
    }
    return typeof d.packsTimeoutNoCacheMs === "number"
      ? d.packsTimeoutNoCacheMs
      : PACKS_NETWORK_TIMEOUT_NO_CACHE_MS;
  }

  // start may be a promise, or a function (noteFirstByte, noteProgress, controller) => promise.
  // The first timer covers silence until the headers. It does not abort,
  // so a late answer can still land. settled means the caller was released.
  // The idle timer and the hard cap are separate. The cap starts when
  // this function starts, which is the start of the fetch, and it covers
  // the whole response including inlined images. After the first-byte
  // release, noteFirstByte and noteProgress still arm the idle timer.
  // The cap aborts the fetch even when chunks keep resetting idle. A stall
  // mid-body cannot stay open, including one Check again left behind.
  // A value that arrives after the first-byte rejection is handed to
  // onLate. A rejection after the deadline, including an aborted body,
  // is dropped.
  function withTimeout(start, ms, onLate, onFinished) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var finished = false;
      var timer = null;
      var idleTimer = null;
      var capTimer = null;
      var controller = typeof AbortController === "function" ? new AbortController() : { abort: function () {}, signal: undefined };
      function clearTimers() {
        if (timer) clearTimeout(timer);
        if (idleTimer) clearTimeout(idleTimer);
        if (capTimer) clearTimeout(capTimer);
        timer = null;
        idleTimer = null;
        capTimer = null;
      }
      function markFinished(kind) {
        if (finished) return;
        finished = true;
        clearTimers();
        if (typeof onFinished === "function") {
          try { onFinished(kind); } catch (e) {}
        }
      }
      function abortFetch() {
        try { controller.abort(); } catch (e) {}
      }
      function failCaller(abort) {
        if (finished) return;
        if (abort) abortFetch();
        if (settled) {
          if (abort) markFinished();
          return;
        }
        settled = true;
        if (abort) markFinished();
        else if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        var err = new Error("timeout");
        err.code = "timeout";
        // Idle and the hard cap abort the fetch. A first-byte timeout
        // does not, so a late body can still arrive.
        if (abort) err.aborted = true;
        reject(err);
      }
      function armIdle() {
        if (finished) return;
        if (idleTimer) clearTimeout(idleTimer);
        var idle = typeof d.bodyIdleMs === "number" ? d.bodyIdleMs : BODY_IDLE_MS;
        idleTimer = setTimeout(function () { failCaller(true); }, idle);
      }
      var cap = typeof d.bodyCapMs === "number" ? d.bodyCapMs : BODY_CAP_MS;
      capTimer = setTimeout(function () { failCaller(true); }, cap);
      timer = setTimeout(function () { failCaller(false); }, ms);
      function noteFirstByte() {
        if (finished) return;
        if (timer) clearTimeout(timer);
        timer = null;
        armIdle();
      }
      function noteProgress() {
        if (finished) return;
        if (timer) clearTimeout(timer);
        timer = null;
        armIdle();
      }
      var started;
      try {
        started = typeof start === "function" ? start(noteFirstByte, noteProgress, controller) : start;
      } catch (err) {
        clearTimers();
        markFinished();
        reject(err);
        return;
      }
      Promise.resolve(started).then(
        function (value) {
          if (finished) return;
          if (settled) {
            var lateDone = Promise.resolve();
            if (typeof onLate === "function") {
              lateDone = Promise.resolve()
                .then(function () { return onLate(value); })
                .catch(function () {});
            }
            // markFinished runs after onLate rejects, including a
            // synchronous throw from onLatePacks, so that throw cannot
            // skip onFinished.
            lateDone.then(markFinished, markFinished);
            return;
          }
          settled = true;
          markFinished("settled");
          resolve(value);
        },
        function (err) {
          // A network failure after the first-byte timeout, and an abort
          // after that deadline, still finishes the fetch. onFinished
          // releases the in-flight slot. The caller was already rejected.
          if (finished) return;
          markFinished();
          if (settled) return;
          settled = true;
          reject(err);
        }
      );
    });
  }

  function restoreTimeoutMs() {
    return typeof d.restoreTimeoutMs === "number" ? d.restoreTimeoutMs : PACKS_NETWORK_TIMEOUT_MS;
  }

  /**
   * What this Google account already owns.
   *
   * This is the whole restore story on Android — reinstall, or a second device
   * signed into the same account, and the unlock comes back with no account of
   * ours and no server. Everywhere else there is nothing to restore from, which
   * is a known and deliberate hole; see EB-0210.
   */
  function listOwned(ms) {
    var timeout = typeof ms === "number" ? ms : PACKS_NETWORK_TIMEOUT_MS;
    return service().then(function (s) {
      if (!s || typeof s.listPurchases !== "function") {
        return { listed: false, service: s, purchases: [] };
      }
      return withTimeout(
        Promise.resolve().then(function () { return s.listPurchases(); }),
        timeout
      )
        .then(function (purchases) {
          return { listed: true, service: s, purchases: purchases || [] };
        })
        .catch(function (err) {
          // A failed list, including a timeout, is not "Play says you do
          // not own this." Offline restore must keep the flag and the cache.
          warn("could not list existing purchases", err);
          return { listed: false, service: s, purchases: [] };
        });
    });
  }

  function ownedToken(purchases) {
    var token = null;
    (purchases || []).forEach(function (p) {
      if (p && areaForSku(p.itemId) && p.purchaseToken) token = p.purchaseToken;
    });
    return token;
  }

  function revokeSupportPacks(requestId) {
    markOwnershipGone(requestId);
    var stored = d.readEntitlements ? d.readEntitlements() : {};
    var next = {};
    var had = false;
    for (var k in stored) {
      if (!Object.prototype.hasOwnProperty.call(stored, k)) continue;
      if (k === "support_packs") {
        had = true;
        continue;
      }
      next[k] = stored[k];
    }
    if (had && d.writeEntitlements) d.writeEntitlements(next);
    var clearing =
      typeof d.clearPaidCache === "function"
        ? Promise.resolve().then(function () { return d.clearPaidCache(); })
        : Promise.resolve();
    return clearing.then(function () {
      if (had && d.onRevoke) d.onRevoke("support_packs");
      return true;
    }).catch(function () {
      if (had && d.onRevoke) d.onRevoke("support_packs");
      return true;
    });
  }

  function readPaidCache() {
    if (typeof d.readPaidCache !== "function") return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return d.readPaidCache(); })
      .then(function (cached) {
        if (!cached || cached.ok === false || !Array.isArray(cached.packs)) return null;
        return {
          ok: true,
          packCount: typeof cached.packCount === "number" ? cached.packCount : cached.packs.length,
          packs: cached.packs,
          fromCache: true,
        };
      })
      .catch(function () { return null; });
  }

  function restore(opts) {
    // The invalid-token bar passes acknowledge:false. Re-acknowledging that
    // rejected token is an extra Play call and does not re-check the purchase.
    var skipAck = opts && opts.acknowledge === false;
    var timeout = restoreTimeoutMs();
    return listOwned(timeout).then(function (listed) {
      if (!listed.listed) return [];
      var granted = [];
      var acks = [];
      var ownsSku = false;
      (listed.purchases || []).forEach(function (p) {
        var area = p && areaForSku(p.itemId);
        if (!area) return;
        ownsSku = true;
        if (p.purchaseToken) lastPurchaseToken = p.purchaseToken;
        if (grant(area)) granted.push(area);
        if (p.purchaseToken && !skipAck) {
          acks.push(
            withTimeout(
              acknowledgePurchase(listed.service, p.purchaseToken, {
                postAcknowledge: d.postAcknowledge,
                sleep: d.sleep,
              }),
              timeout
            ).then(function (ack) {
              if (!ack.acknowledged) {
                warn("existing purchase not acknowledged — Play may refund it in 3 days", ack);
              }
              return ack;
            }).catch(function () {
              warn("existing purchase acknowledge timed out; Play has not answered yet");
              return { acknowledged: false, reason: "timeout" };
            })
          );
        }
      });
      // One empty listPurchases result is not a revoke. Re-check the last
      // token this session listed. Only purchase-revoked from that check
      // clears the unlock and the cache.
      if (!ownsSku) {
        if (!lastPurchaseToken || typeof d.postPacks !== "function") return [];
        // A load already in flight owns the re-check. Two restores
        // share one slot, so they send one POST.
        if (openFlight) return [];
        return loadMissingSku(timeout).then(function (result) {
          // The re-check already went through absentSku and withTimeout.
          // A successful answer is in the cache. Show it too, so the
          // caller does not have to throw the packs away unseen.
          if (result && result.ok && Array.isArray(result.packs) && typeof d.onCachedPacks === "function") {
            try { d.onCachedPacks(result, result.requestId); } catch (e) {}
          }
          return [];
        });
      }
      return Promise.all(acks).then(function () { return granted; });
    });
  }

  /**
   * Ask the packs service for the bodies this token is allowed to hold.
   * The count in the response is the number to show. A network failure,
   * and any error that is not a definitive revocation, falls back to the
   * keyed cache. A fresh response replaces the paid set, so a pack
   * missing from that response leaves the screen. Startup refuses a
   * checked-in allow list that omits a baseline id. A pull takes effect
   * at its declared date. This publication serves 40 packs. Past-buyer
   * copies are not in this release.
   * purchase-revoked (refund or consumed) clears the flag and the cache.
   * A void that does not change purchaseState or consumptionState is not
   * this code. invalid-token does not clear the cache. purchase-pending
   * is HTTP 409. It keeps the unlock, the cache, and any packs already
   * shown. Play 400/404 and a malformed body are error invalid-token
   * with no reason. The fallback below uses that error so the retry
   * note can tell them apart. An older purchase-not-active reason is
   * still passed through. A Play list that omits the SKU does not clear
   * the flag or the cache. It re-checks the last token from this session
   * when one was listed. The wait is until the first byte, not the
   * inlined image body. With a cache that wait is short. With none, it
   * is longer. listOwned and the packs POST share that one budget.
   * After the headers, the body has its own idle deadline, about 30
   * seconds, reset as bytes arrive. That idle wait aborts the fetch.
   * It still arms after the first-byte deadline, so a late body that
   * stalls is aborted. A hard cap starts when the fetch starts, not
   * when the body starts, and closes the fetch even when bytes keep
   * arriving. It covers the inlined image body. The first-byte wait does not abort, so a late
   * answer can still land. A
   * cached payload is reported through onCachedPacks before that wait,
   * with this request's id, so it follows the same ordering as a
   * network result. A cache fallback does not count as a newer success.
   * A success that arrives after the wait is still written to the
   * cache, and onLatePacks re-renders it, unless a newer load has
   * succeeded or a newer check found the purchase gone. A newer load
   * that also times out does not drop it. A late network failure is
   * dropped. The timeout the caller already painted stays. When the
   * shared budget is already spent, the packs POST is not sent. The
   * in-flight slot is acquired once and released exactly once.
   * finishFlight is the onFinished callback. An idle or hard-cap abort
   * releases through it. A first-byte timeout does not abort, and the
   * finally still releases the caller slot so the next load can post.
   * A late body can still be written and painted. That delivery does
   * not own the slot. A throw from onLatePacks cannot skip the release.
   * The on-time path keeps the slot until the cache write finishes.
   * A second load while the attempt is still open shares it and does
   * not send another POST. Restore still reads
   * Play's list. A list that omits the SKU does not revoke. A cold
   * start with no cache still calls the packs service before reporting
   * that the packs could not load.
   */
  function withPendingReason(cached) {
    var copy = {};
    Object.keys(cached).forEach(function (key) {
      copy[key] = cached[key];
    });
    copy.reason = "purchase-pending";
    return copy;
  }

  function pendingOrCache() {
    return readPaidCache().then(function (cached) {
      if (cached) return withPendingReason(cached);
      return { ok: false, reason: "purchase-pending", packCount: 0 };
    });
  }

  function cacheOrReason(reason) {
    return readPaidCache().then(function (cached) {
      return cached || { ok: false, reason: reason, packCount: 0 };
    });
  }

  // Owned-SKU and absent-SKU answers share this. stillCurrent runs
  // before the cache write and again after it. A superseded request
  // does not put a body back over a newer success or a revoke.
  function applyPackResponse(res, requestId, fallbackReason) {
    var fallback = fallbackReason || "packs-failed";
    if (res && res.error === "purchase-revoked") {
      return revokeSupportPacks(requestId).then(function () {
        return { ok: false, reason: res.error, packCount: 0 };
      });
    }
    if (res && res.error === "purchase-pending") return pendingOrCache();
    if (!stillCurrent(requestId)) {
      var superseded = res && res.ok && Array.isArray(res.packs) ? "not-owned" : "sku-absent";
      return { ok: false, reason: superseded, packCount: 0 };
    }
    if (res && res.ok && Array.isArray(res.packs)) {
      if (requestId > succeededRequestId) succeededRequestId = requestId;
      return writePayload(packsPayload(res)).then(function (payload) {
        if (revokeWon(requestId)) {
          return clearPaidCache().then(function () {
            return { ok: false, reason: "not-owned", packCount: 0 };
          });
        }
        if (!stillCurrent(requestId)) {
          return { ok: false, reason: "not-owned", packCount: 0 };
        }
        return payload;
      });
    }
    return readPaidCache().then(function (cached) {
      return (
        cached || {
          ok: false,
          reason: (res && (res.reason || res.error)) || fallback,
          packCount: 0,
        }
      );
    });
  }

  // A list that omits the SKU is not a revoke. Re-check through the
  // same budget, idle timer, 240s cap, and abort as the owned POST.
  // Never POST without a token. A cold start with no token returns
  // sku-absent and does not call the packs service. Only
  // purchase-revoked from a token re-check clears the unlock and the
  // cache. A late answer applies through deliverLate.
  function absentSku(requestId, budgetMs, onFinished) {
    if (!lastPurchaseToken) return cacheOrReason("sku-absent");
    if (typeof d.postPacks !== "function") return cacheOrReason("sku-absent");
    return recheckAbsentSku(requestId, budgetMs, onFinished);
  }

  function recheckAbsentSku(requestId, budgetMs, onFinished) {
    if (!lastPurchaseToken) return cacheOrReason("sku-absent");
    var ms = typeof budgetMs === "number" ? budgetMs : 0;
    if (ms <= 0) return cacheOrReason("timeout");
    return beginDownload(lastPurchaseToken, ms, requestId, onFinished, "sku-absent");
  }

  function packsPayload(res) {
    return {
      ok: true,
      packCount: typeof res.packCount === "number" ? res.packCount : res.packs.length,
      packs: res.packs,
    };
  }

  function writePayload(payload) {
    if (typeof d.writePaidCache !== "function") return Promise.resolve(payload);
    return Promise.resolve()
      .then(function () { return d.writePaidCache(payload); })
      .then(function () { return payload; })
      .catch(function () { return payload; });
  }

  function stillCurrent(requestId) {
    return !(goneRequestId > requestId || succeededRequestId > requestId);
  }

  // A newer success owns the cache. Clear only when this request was
  // revoked and nothing newer has already been stored.
  function revokeWon(requestId) {
    return goneRequestId > requestId && !(succeededRequestId > requestId);
  }

  function clearPaidCache() {
    if (typeof d.clearPaidCache !== "function") return Promise.resolve();
    return Promise.resolve()
      .then(function () { return d.clearPaidCache(); })
      .catch(function () {});
  }

  function deliverLate(res, requestId) {
    if (!stillCurrent(requestId)) return;
    if (res && res.error === "purchase-revoked") {
      return revokeSupportPacks(requestId).then(function () {
        if (!stillCurrent(requestId)) return;
        if (typeof d.onLatePacks === "function") {
          d.onLatePacks({ ok: false, reason: res.error, packCount: 0 }, requestId);
        }
      });
    }
    if (res && res.error === "purchase-pending") {
      if (!stillCurrent(requestId)) return;
      if (typeof d.onLatePacks === "function") {
        d.onLatePacks({ ok: false, reason: "purchase-pending", packCount: 0 }, requestId);
      }
      return;
    }
    // A late network failure is not a payload. It is dropped.
    if (!(res && res.ok && Array.isArray(res.packs))) return;
    var payload = packsPayload(res);
    if (requestId > succeededRequestId) succeededRequestId = requestId;
    return writePayload(payload).then(function () {
      // A revoke can land while the cache write is in flight. Clear
      // only for that revoke. A newer success keeps the cache it wrote.
      if (revokeWon(requestId)) return clearPaidCache();
      if (!stillCurrent(requestId)) return;
      if (typeof d.onLatePacks === "function") d.onLatePacks(payload, requestId);
    });
  }

  var openFlight = null;
  var openDownload = null;

  function settleDownload(download, result) {
    if (!download || download.done) return;
    download.done = true;
    download.result = result;
    var waiters = download.waiters.splice(0);
    waiters.forEach(function (resolve) { resolve(result); });
  }

  function releaseStream(download) {
    download.streamDone = true;
    if (openDownload === download) openDownload = null;
  }

  function tagDownload(download, result) {
    if (!result || typeof result !== "object" || result.requestId != null) return result;
    var copy = {};
    Object.keys(result).forEach(function (key) { copy[key] = result[key]; });
    copy.requestId = download.requestId;
    return copy;
  }

  function waitForDownload(download) {
    if (download.done) return Promise.resolve(tagDownload(download, download.result));
    return new Promise(function (resolve) {
      download.waiters.push(function (result) { resolve(tagDownload(download, result)); });
    });
  }

  // One open packs download. A retry after a first-byte timeout shares
  // it instead of starting a second POST while the body is still streaming.
  function beginDownload(token, ms, requestId, onFinished, fallbackReason) {
    if (!token) return cacheOrReason("sku-absent");
    if (openDownload && !openDownload.streamDone) return waitForDownload(openDownload);
    var fallback = fallbackReason || "packs-failed";
    var download = {
      done: false,
      streamDone: false,
      result: null,
      waiters: [],
      requestId: requestId,
    };
    openDownload = download;
    function finishStream(kind) {
      if (typeof onFinished === "function") onFinished(kind);
      if (kind === "settled") return;
      releaseStream(download);
      if (!download.done) {
        cacheOrReason(fallback).then(function (payload) {
          settleDownload(download, payload);
        });
      }
    }
    return withTimeout(
      function (noteFirstByte, noteProgress, controller) {
        return d.postPacks({
          purchaseToken: token,
          onFirstByte: noteFirstByte,
          onProgress: noteProgress,
          signal: controller && controller.signal,
        });
      },
      ms,
      function (res) {
        releaseStream(download);
        return Promise.resolve()
          .then(function () { return deliverLate(res, requestId); })
          .then(function () { return readPaidCache(); })
          .then(function (cached) {
            var result = null;
            if (res && res.ok && Array.isArray(res.packs) && stillCurrent(requestId)) {
              result = packsPayload(res);
            }
            if (!result) result = cached || { ok: false, reason: fallback, packCount: 0 };
            settleDownload(download, result);
            return result;
          })
          .catch(function () {
            var failed = { ok: false, reason: fallback, packCount: 0 };
            settleDownload(download, failed);
            return failed;
          });
      },
      finishStream
    ).then(
      function (res) {
        releaseStream(download);
        return applyPackResponse(res, requestId, fallback).then(function (payload) {
          settleDownload(download, payload);
          return payload;
        });
      },
      function (err) {
        var aborted = !!(err && err.aborted);
        var timedOut = err && err.code === "timeout";
        if (aborted || !timedOut) {
          releaseStream(download);
          var reason = timedOut ? "timeout" : fallback;
          return cacheOrReason(reason).then(function (payload) {
            settleDownload(download, payload);
            return payload;
          });
        }
        return cacheOrReason("timeout");
      }
    );
  }

  function loadMissingSku(budgetMs) {
    if (openDownload && !openDownload.streamDone) return waitForDownload(openDownload);
    if (openFlight) return openFlight.promise;
    var requestId = ++packsRequestSeq;
    var flight = { id: requestId, promise: null };
    var released = false;
    function releaseSlot() {
      if (released) return;
      released = true;
      if (openFlight === flight) openFlight = null;
    }
    function finishFlight(kind) {
      if (kind === "settled") return;
      releaseSlot();
    }
    openFlight = flight;
    var attempt = Promise.resolve().then(function () {
      return absentSku(requestId, budgetMs, finishFlight);
    }).then(function (result) {
      if (!result || typeof result !== "object" || result.requestId != null) return result;
      var copy = {};
      Object.keys(result).forEach(function (key) {
        copy[key] = result[key];
      });
      copy.requestId = requestId;
      return copy;
    });
    flight.promise = attempt.finally(releaseSlot);
    return flight.promise;
  }

  function loadPaidPacks() {
    if (openDownload && !openDownload.streamDone) return waitForDownload(openDownload);
    if (openFlight) return openFlight.promise;
    var requestId = ++packsRequestSeq;
    var flight = { id: requestId, promise: null };
    var released = false;
    function releaseSlot() {
      if (released) return;
      released = true;
      if (openFlight === flight) openFlight = null;
    }
    // "settled" is the on-time response, which still has the cache
    // write ahead of it. Every other finish releases. An aborted
    // fetch is not a hold: idle and the hard cap call this, and a
    // synchronous throw from onLatePacks cannot skip it.
    function finishFlight(kind) {
      if (kind === "settled") return;
      releaseSlot();
    }
    openFlight = flight;
    var attempt = Promise.resolve().then(function () {
      return readPaidCache().then(function (cachedFirst) {
        if (cachedFirst && typeof d.onCachedPacks === "function") {
          try { d.onCachedPacks(cachedFirst, requestId); } catch (e) {}
        }
        var budget = networkTimeoutMs(!!cachedFirst);
        function now() {
          return typeof d.now === "function" ? d.now() : Date.now();
        }
        var startedAt = now();
        function remaining() {
          var left = budget - (now() - startedAt);
          return left > 0 ? left : 0;
        }
        return listOwned(remaining()).then(function (listed) {
          if (!listed.listed) return cacheOrReason("list-failed");
          var token = ownedToken(listed.purchases);
          if (token) lastPurchaseToken = token;
          if (!token) return absentSku(requestId, remaining(), finishFlight);
          if (typeof d.postPacks !== "function") return cacheOrReason("no-packs-endpoint");
          if (remaining() <= 0) return cacheOrReason("timeout");
          // A first-byte timeout leaves the body streaming. beginDownload
          // keeps that one POST open. A retry shares it.
          return beginDownload(token, remaining(), requestId, finishFlight, "packs-failed");
        });
      });
    }).then(function (result) {
      if (!result || typeof result !== "object" || result.requestId != null) return result;
      var copy = {};
      Object.keys(result).forEach(function (key) {
        copy[key] = result[key];
      });
      copy.requestId = requestId;
      return copy;
    }, function () {
      return { ok: false, reason: "packs-failed", packCount: 0, requestId: requestId };
    });
    // The caller slot is released here exactly once, including a
    // first-byte timeout and the absent-SKU re-check. finishFlight
    // may already have released an abort. A late body does not own it.
    flight.promise = attempt.finally(releaseSlot);
    return flight.promise;
  }

  /**
   * Buy one area.
   *
   * Resolves with an outcome rather than rejecting, because every failure here
   * is ordinary: no store, user dismissed the sheet, payment declined. The
   * caller renders a message; nothing throws.
   */
  function buy(area) {
    var sku = skuForArea(area);
    if (!sku) return Promise.resolve({ ok: false, reason: "unknown-area" });
    if (typeof d.startPayment !== "function") {
      return Promise.resolve({ ok: false, reason: "no-payment-support" });
    }
    return service().then(function (s) {
      if (!s) return { ok: false, reason: "no-store" };
      return Promise.resolve()
        .then(function () { return d.startPayment(sku); })
        .then(function (result) {
          var token = result && result.purchaseToken;
          if (!token) return { ok: false, reason: "no-purchase-token" };
          // Grant BEFORE acknowledging. The user has paid; an acknowledgement
          // problem is ours to chase, and must never look to them like the
          // purchase failed.
          grant(area);
          return acknowledgePurchase(s, token, {
            postAcknowledge: d.postAcknowledge,
            sleep: d.sleep,
          }).then(function (ack) {
            if (!ack.acknowledged) {
              // Loud on purpose. Play reverses an unacknowledged purchase after
              // three days and nothing else in the app will ever mention it.
              warn("purchase not acknowledged — Play may refund it in 3 days", ack);
            }
            var complete = result && result.complete;
            return Promise.resolve()
              .then(function () {
                if (typeof complete === "function") return complete("success");
              })
              .catch(function () {})
              .then(function () {
                return { ok: true, area: area, acknowledged: !!ack.acknowledged, ack: ack };
              });
          });
        })
        .catch(function (err) {
          return {
            ok: false,
            reason: "payment-failed",
            error: String((err && err.message) || err),
          };
        });
    });
  }

  return {
    available: available,
    detailsFor: detailsFor,
    restore: restore,
    buy: buy,
    loadPaidPacks: loadPaidPacks,
    packsRequestPending: function () { return !!openFlight; },
  };
}

var API = {
  BILLING_METHOD: BILLING_METHOD,
  SUPPORT_PACKS_SKU: SUPPORT_PACKS_SKU,
  SKUS: SKUS,
  ACKNOWLEDGE_ENDPOINT: ACKNOWLEDGE_ENDPOINT,
  PACKS_ENDPOINT: PACKS_ENDPOINT,
  PAID_CACHE_NAME: PAID_CACHE_NAME,
  PAID_CACHE_URL: PAID_CACHE_URL,
  resolveAcknowledgeUrl: resolveAcknowledgeUrl,
  resolvePacksUrl: resolvePacksUrl,
  areaForSku: areaForSku,
  skuForArea: skuForArea,
  acknowledgePurchase: acknowledgePurchase,
  createPurchases: createPurchases,
};

// --- Browser binding -------------------------------------------------------
// The only place real browser APIs are touched. Feature detection is the whole
// gate: window.getDigitalGoodsService is undefined outside a TWA, so the same
// deployed page is a purchasable app on a phone and a free website everywhere
// else, with no build split.
if (typeof window !== "undefined") {
  API.browserDeps = function (entitlementsApi, onUnlock, onRevoke) {
    function acknowledgeUrl() {
      return resolveAcknowledgeUrl(window.DRILLGROUND_ACKNOWLEDGE_ENDPOINT);
    }
    function packsUrl() {
      return resolvePacksUrl(
        window.DRILLGROUND_PACKS_ENDPOINT,
        window.DRILLGROUND_ACKNOWLEDGE_ENDPOINT
      );
    }
    function readJsonResponse(res, onProgress) {
      function parsed(text) {
        var json = null;
        if (text) {
          try { json = JSON.parse(text); } catch (e) { json = null; }
        }
        return { res: res, json: json };
      }
      if (!res.body || typeof res.body.getReader !== "function") {
        return res.text().then(parsed);
      }
      var reader = res.body.getReader();
      var decoder = typeof TextDecoder === "function" ? new TextDecoder() : null;
      var parts = [];
      function pump() {
        return reader.read().then(function (part) {
          if (part.done) {
            // decode() returns only the chunk it was given, plus any
            // partial character it was holding. The body is those
            // strings joined. The final call only flushes a trailing
            // split character; it is not the response.
            if (decoder) parts.push(decoder.decode());
            return parsed(parts.join(""));
          }
          if (typeof onProgress === "function") {
            try { onProgress(); } catch (e) {}
          }
          if (decoder) parts.push(decoder.decode(part.value, { stream: true }));
          else parts.push(String(part.value));
          return pump();
        });
      }
      return pump();
    }
    return {
      getService: function () {
        if (typeof window.getDigitalGoodsService !== "function") return null;
        return window.getDigitalGoodsService(BILLING_METHOD);
      },
      readEntitlements: function () {
        try {
          return entitlementsApi.parseEntitlements(
            window.localStorage.getItem(entitlementsApi.STORAGE_KEY)
          );
        } catch (e) {
          return {};
        }
      },
      writeEntitlements: function (next) {
        try {
          window.localStorage.setItem(entitlementsApi.STORAGE_KEY, JSON.stringify(next));
        } catch (e) {
          // Private mode or a full quota. The purchase still stands with Play,
          // and restore() recovers it on the next launch.
        }
      },
      startPayment: function (sku) {
        if (typeof window.PaymentRequest !== "function") {
          return Promise.reject(new Error("PaymentRequest unavailable"));
        }
        // The amount is a required placeholder: Play charges the price set in
        // Console, not anything named here.
        var request = new window.PaymentRequest(
          [{ supportedMethods: BILLING_METHOD, data: { sku: sku } }],
          { total: { label: "Total", amount: { currency: "USD", value: "0" } } }
        );
        return request.show().then(function (response) {
          return {
            purchaseToken: response && response.details && response.details.purchaseToken,
            complete: function (status) { return response.complete(status); },
          };
        });
      },
      postAcknowledge: function (body) {
        var url = acknowledgeUrl();
        if (!url || typeof window.fetch !== "function") {
          return Promise.resolve({ ok: false, error: "no-acknowledge-endpoint" });
        }
        return window
          .fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              purchaseToken: body && body.purchaseToken,
              productId: (body && body.productId) || SUPPORT_PACKS_SKU,
            }),
          })
          .then(readJsonResponse)
          .then(function (parsed) {
            var json = parsed.json;
            var res = parsed.res;
            return {
              ok: !!(json && json.ok),
              alreadyAcknowledged: !!(json && json.alreadyAcknowledged),
              error: (json && json.error) || (res.ok ? undefined : "acknowledge-failed"),
              message: json && json.message,
              transient: res.status >= 500 || res.status === 429,
              status: res.status,
            };
          });
      },
      postPacks: function (body) {
        var url = packsUrl();
        if (!url || typeof window.fetch !== "function") {
          return Promise.resolve({ ok: false, error: "no-packs-endpoint" });
        }
        var init = {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ purchaseToken: body && body.purchaseToken }),
        };
        if (body && body.signal) init.signal = body.signal;
        return window
          .fetch(url, init)
          .then(function (res) {
            // Headers are the first byte. The body stays on an idle
            // timer that resets as chunks arrive.
            if (body && typeof body.onFirstByte === "function") {
              try { body.onFirstByte(); } catch (e) {}
            }
            return readJsonResponse(res, body && body.onProgress);
          })
          .then(function (parsed) {
            var json = parsed.json;
            if (!json) {
              var status = parsed.res && parsed.res.status;
              if (status === 429) return { ok: false, error: "rate-limited", status: status };
              if (typeof status === "number" && status >= 500) {
                return { ok: false, error: "server-error", status: status };
              }
              return { ok: false, error: "packs-failed", status: status };
            }
            return {
              ok: !!json.ok,
              error: json.error,
              reason: json.reason,
              packCount: json.packCount,
              packs: json.packs,
              status: parsed.res.status,
            };
          });
      },
      readPaidCache: function () {
        if (typeof caches === "undefined" || !caches || typeof caches.open !== "function") {
          return Promise.resolve(null);
        }
        return caches.open(PAID_CACHE_NAME).then(function (cache) {
          return cache.match(PAID_CACHE_URL);
        }).then(function (cached) {
          if (!cached) return null;
          return cached.json();
        });
      },
      writePaidCache: function (payload) {
        if (typeof caches === "undefined" || !caches || typeof caches.open !== "function") {
          return Promise.resolve();
        }
        return caches.open(PAID_CACHE_NAME).then(function (cache) {
          return cache.put(
            PAID_CACHE_URL,
            new Response(JSON.stringify(payload), {
              headers: { "content-type": "application/json" },
            })
          );
        });
      },
      clearPaidCache: function () {
        if (typeof caches === "undefined" || !caches || typeof caches.delete !== "function") {
          return Promise.resolve();
        }
        return caches.delete(PAID_CACHE_NAME);
      },
      onUnlock: onUnlock,
      onRevoke: onRevoke,
      warn: function (message, detail) {
        if (window.console && window.console.warn) {
          window.console.warn("[drillground/purchase] " + message, detail);
        }
      },
    };
  };
}

if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundPurchase = API;
}

})();
