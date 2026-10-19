# App icons

**These are design exports. Nothing in this repo generates them, and nothing
should.**

| File | Size | Where it is used |
|---|---|---|
| `icon-192.png` | 192×192 | Web manifest — Android home screen |
| `icon-512.png` | 512×512 | Web manifest — splash screen, and what Bubblewrap bakes into the `.aab` |
| `icon-maskable-512.png` | 512×512 | Web manifest — Android adaptive launcher icon |
| `apple-touch-icon.png` | 180×180 | Safari "Add to Home Screen" |
| `store-icon-1024.png` | 1024×1024 | Apple App Store listing |

The Play Store **feature graphic** lives next door at
[`../../store/feature-graphic.png`](../../store/feature-graphic.png) — 1024×500,
no alpha, checked by the same test file.

## The mark

A **Maltese cross** with white panels and a black helmet, on the app background
`#0c0a09`. Two versions differing only in detail — same silhouette, same colors:

- **Launcher icons** (192, 512, maskable) — cross and helmet only.
- **Store icons** (apple-touch, 1024) — adds the ladder and hydrant. Displayed
  large, so the detail is worth having.

### Why white panels on black

The cross has to be recognisable at **48px**, and that depends on how hard it
separates from the field. Against near-black, white manages about **21:1**; the
brand red `#b91c1c` manages about **2:1**, because red is a dark color. A red
cross on black muddies into a smudge at thumbnail size.

So the red lives in the wordmark, the feature graphic, and the app's own
`theme_color`, which is where large fields of it belong. The icon gets the
contrast.

This is the third mark in this slot — a white triangle, then a shield, now the
cross. Anything that draws the mark separately has to be updated with it; see
`.brand-mark` in `app/index.html`, which is the one that keeps getting missed.

## Constraints that are enforced, not remembered

`src/app-icons.test.js` checks all of it. In particular:

- **No alpha channel anywhere.** Apple rejects a transparent store icon
  outright, and a launcher icon with holes shows the wallpaper through them.
- **The maskable icon keeps its mark inside the centred 80% circle.** Android
  crops it to a circle, squircle or rounded square depending on the launcher;
  only that circle is guaranteed to survive.
- **A uniform border on every icon**, exactly `#0c0a09`. Two separate exports
  have now shipped flat padding around artwork whose own field was a slightly
  different shade — once in red, once in near-black — each leaving a visible
  square seam. The test walks the whole border, not just the corners, because a
  corner sample missed it the first time. Backgrounds are flood-filled from the
  border to the exact value before committing.
- **A color count above 200**, which no flat placeholder can reach.

## There used to be a generator

`src/generate-app-icons.js` drew a white triangle on red procedurally, with no
image library. It was deleted when the real artwork landed — it took no
arguments, wrote to these exact paths, and would have silently overwritten the
mark with triangles the next time anyone ran it. A script that can only destroy
work is not a fallback.

## Replacing an icon

Export it, drop it in with the same filename, and run:

```
node --test products/drillground/src/app-icons.test.js
```

Then bump `CACHE_VERSION` in [`../sw.js`](../sw.js) and update
`src/sw-shell.lock.json` — the icons are precached **cache-first**, so without a
bump every device that has already visited keeps serving the old artwork
indefinitely. `src/sw-cache.test.js` will fail until you do.

If the icons change, **the app must be redeployed before a new `.aab` is built**
— Bubblewrap fetches them from the live site, not from this directory. See
[`../../docs/play-release-runbook.md`](../../docs/play-release-runbook.md).
