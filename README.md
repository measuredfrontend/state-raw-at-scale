# $state vs $state.raw at scale: a decision rule with numbers

The Svelte docs say `$state.raw` "can improve performance with large arrays and objects that you weren't planning to mutate anyway". This demo measures where "large" starts, what the cost actually is, and when `$state` is the faster choice.

**The claim:** assigning a big list to `$state` is free; Svelte creates proxies when you *read* rows. The cost is every full read: a `$derived` total, filter or sort, or a full `{#each}`, re-reads every row through the proxy on every change. From about 10,000 rows, if something reads the whole list on each change, use `$state.raw` with immutable updates. Under about 1,000 rows it doesn't matter. Single edits in a rendered list are where `$state` wins, and a hybrid (raw list, rows promoted to `$state` on first edit) gets both. The thresholds are specific to the machine and versions below.

## What it measures

Five ways to hold the same list of invoice-like rows (9 fields, one nested object, one small array):

| Variant | List | Edit one row |
| --- | --- | --- |
| `deep` | `$state<Row[]>` | in place |
| `raw` | `$state.raw<Row[]>` | `items.with(i, { ...items[i], price })` |
| `hybrid` | `$state.raw`; a row becomes `$state` on its first edit | first edit: one array copy; then in place |
| `class` | `$state.raw` of class instances with `$state` fields | in place |
| `map` | `SvelteMap<number, Row>` | `map.set(id, { ...row, price })` |

Nine operations (assign, read all twice, edit a field twice, replace, append, sort, filter via `$derived`) in three page shapes:

- `data`: no list on screen; a `$derived` total over every row and a filtered count
- `window`: a keyed `{#each}` over the first 50 rows (what a virtual list renders)
- `list`: a keyed `{#each}` over every row

Sizes 1k, 10k, 100k, 250k (full list: up to 100k unthrottled, up to 10k at 4x). Unthrottled and at 4x CPU throttling (Chrome DevTools protocol). Each configuration: a fresh page, one discarded warm-up, 5 measured runs; median here, min and max in `results/measure.json`. Time = until Svelte has updated the DOM (`flushSync`); the file also has the time to the next frame. The browser timer resolution is about 0.1 ms. Memory = V8 heap after two forced GCs, minus the heap with the plain rows already created. Plus: lazy-proxy checks on a list nothing renders, `$state.snapshot`, server render time on `node build`, and hydration.

## Run it

```sh
bun install
bun run build
bunx playwright install chromium
MAX_LIST_4X=10000 bun run measure   # starts `node build` on port 4304 (~30 min); writes results/measure.json
node scripts/report.mjs             # every table: results/measure.report.md
node scripts/compare.mjs            # summary numbers: results/summary.json
bun run test:pack                   # T1-T11, the tests behind every rule (~5 min)
bun run start                       # to click around: http://localhost:3000 (/bench, /gotchas, /ssr/deep, /ssr/raw)
```

On Windows PowerShell, set the variable first: `$env:MAX_LIST_4X='10000'`. Without it, the run adds the full-list 100k configurations at 4x (about 45 minutes more). Measure production builds only: Svelte's dev build runs extra checks in the proxy. Close other heavy programs: timing depends on a quiet machine.

## Measured (29 Sep 2026, Windows 11, i9-13900KF, Chromium 153, no other load)

**Assigning vs reading** (a list nothing renders, 100,000 rows, unthrottled):

| | `$state` | `$state.raw` |
| --- | --- | --- |
| assign | 0.1 ms, +0 MB | 0.1 ms, +0 MB |
| first read of every row | 109 ms, +112 MB | 0.4 ms |
| second read | 40 ms | 0.3 ms |

**One full read, per row:** `$state` 0.45 µs, `$state.raw` 0.003 µs unthrottled; 1.83 µs vs 0.014 µs at 4x. One frame (16.7 ms) fits about 37,000 rows unthrottled and 9,000 at 4x.

**Edit one row while a `$derived` total reads every row** (data page):

| Rows | `$state` 1x | `$state.raw` 1x | `$state` 4x | `$state.raw` 4x |
| --- | --- | --- | --- | --- |
| 1,000 | 0.4 ms | 0.1 ms | 2.3 ms | 0.6 ms |
| 10,000 | 4.4 ms | 0.3 ms | 21 ms | 1.4 ms |
| 100,000 | 49 ms | 2.2 ms | 203 ms | 9.7 ms |
| 250,000 | 122 ms | 5.3 ms | 522 ms | 23 ms |

**Full list rendered** (unthrottled):

| Rows | first render `$state` | first render `$state.raw` | edit one row `$state` | edit one row `$state.raw` | hybrid, second edit |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 13 ms | 5.9 ms | 0.1 ms | 0.3 ms | 0.1 ms |
| 10,000 | 227 ms | 56 ms | 0.4 ms | 1.8 ms | 0.3 ms |
| 100,000 | 12,624 ms | 536 ms | 1.6 ms | 21 ms | 2.3 ms |

**All variants, 100,000 rows, unthrottled** (data page unless noted):

| | `$state` | `$state.raw` | hybrid | class | `SvelteMap` |
| --- | --- | --- | --- | --- | --- |
| assign (+ first `$derived` total) | 159 ms | 0.4 ms | 1.6 ms | 66 ms | 18 ms |
| edit one row | 49 ms | 2.2 ms | 3.3 ms | 1.4 ms | 2.1 ms |
| edit it again, full list rendered | 1.6 ms | 17 ms | 2.3 ms | 1.7 ms | 18 ms |
| sort | 413 ms | 24 ms | 39 ms | 55 ms | n/a |
| filter via `$derived` | 67 ms | 2.2 ms | 5.1 ms | 20 ms | 1.3 ms |
| heap after a full read | 148 MB | 0 MB | 0 MB | 26 MB | 16 MB |

**Windowed list** (first 50 rows rendered), 250,000 rows, unthrottled: edit one row 0.1 ms with `$state`, 4.3 ms with raw; but sort 1,060 ms vs 77 ms and filter 250 ms vs 13 ms.

**Server and hydration:** server render of 10,000 rows 19 ms with either (same compiled code); hydration of 10,000 server-rendered rows 606 ms vs 457 ms unthrottled, 2,989 ms vs 2,068 ms at 4x.

**Snapshots** (10,000 rows): `$state.snapshot` of raw rows 70 ms vs `structuredClone` 11 ms; of an unread `$state` list 134 ms (`structuredClone` of the proxy throws).

All tables, with min and max: `node scripts/report.mjs` → `results/measure.report.md`. Raw numbers: `results/measure.json`, `results/summary.json`, `results/pack-tests.json`.

## Findings

1. **Assigning a `$state` list is free.** Proxies and signals are created lazily, per row and field, on first read (T4; `svelte/src/internal/client/proxy.js`, the `get` trap).
2. **Full reads through the proxy were over 100 times slower** than on plain objects at 100k and 250k rows. Features that re-read every row on each change (totals, filters, sorts, full renders) are where `$state` costs.
3. **From about 10,000 rows, with a full read per change, `$state` goes over a frame on a 4x-throttled CPU** (21 ms per edit at 10k). Unthrottled, it crossed 16.7 ms between 10k and 100k rows.
4. **`$state` wins single edits in a fully rendered list:** 1.6 ms vs 21 ms at 100k, because a new array makes the keyed `{#each}` walk every row. The hybrid gets raw's reads and `$state`'s repeated edits (T5, T6).
5. **Rendering 100,000 rows from `$state` was superlinear:** 12.6 s vs 0.54 s; 10,000 rows was about 4x. Not investigated further.
6. **`$state.raw` mutated in place never shows up**, and a new array still shows the old field of the same row object; only a new row object shows it (T3).
7. **A `$state` array returns proxies:** `includes(original)` is `false`, and writes through the proxy don't reach the original object (T7).
8. **`$state.snapshot` is a full deep copy**, about 6x slower than `structuredClone` on plain rows (T8).
9. **The server doesn't care:** `$state(...)` compiles to the plain value; render time was the same (T9). Hydration reads every row, so `$state` hydrated slower.
10. The earlier probe's "assign 62 ms" for 100k rows was really the first full read: its page had a `$derived` over every row.

Versions: Svelte 5.57.1, SvelteKit 2.70.3, adapter-node 5.5.7, Vite 8.3.1, Playwright 1.63.0 (Chromium 153.0.8010.12), Node 26.3.0.

## Two rules you can use today

1. **From about 10,000 rows, if anything reads the whole list when it changes (a `$derived` total, filter or sort, a full `{#each}`), use `$state.raw` and replace the array on every change.** (Tests `T2`, `T10`, `T11`)
2. **Never mutate `$state.raw` in place, and replace the changed row object too, not only the array.** (Test `T3`)

The Svelte docs already recommend `$state.raw` for large data you don't mutate ([$state](https://svelte.dev/docs/svelte/$state)). This demo adds where "large" starts on one machine, why assigning isn't the cost, where `$state` is faster, and the hybrid.

The full set (rules for windowed lists, the hybrid, identity, snapshots and SSR, an audit script and an audit prompt, for Claude Code, Cursor, Copilot and AGENTS.md) is **Measured Rules: $state vs $state.raw at scale**, coming in January 2027 at [measuredfrontend.com](https://measuredfrontend.com). Free checklist: [measuredfrontend.com/free](https://measuredfrontend.com/free).

## Key files

- `src/lib/stores.svelte.ts`: the five variants (`DeepList`, `RawList`, `HybridList` + `editable()`, `ClassList` + `RowState`, `MapList`)
- `src/lib/rows.ts`: the seeded row generator
- `src/routes/bench/+page.svelte`: the benchmark page and the `timed()` helper
- `src/routes/gotchas/+page.svelte`: raw in-place mutation, identity, fine-grained edits, lazy proxies, snapshots
- `src/routes/ssr/deep`, `src/routes/ssr/raw`: the same list rendered on the server
- `scripts/measure.mjs`, `scripts/report.mjs`, `scripts/compare.mjs`, `scripts/pack-tests.mjs`, `scripts/lib.mjs`
- `results/measure.json` (final run, no other load), `results/measure-under-load.json` (an earlier full run, including full-list 100k at 4x, while a GPU job ran; half of the medians within 6% of the final run, 90% within 35%: `results/summary.json`), `results/pack-tests.json`

## Licence

MIT. Use it, learn from it, ship it. Made by [Measured Frontend](https://measuredfrontend.com): frontend patterns, measured before they're taught. Not affiliated with or endorsed by the Svelte project.
