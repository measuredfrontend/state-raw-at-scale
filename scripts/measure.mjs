// $state vs $state.raw at scale: timing and memory in a real browser, plus the server side.
//   bun run build && bun run measure
// Writes results/measure.json (source of truth for the README, guide, video and pack).
// Env: ONLY=bench,quiet,ssr,hydration  RUNS=5  THROTTLES=1,4  SIZES=1000,10000,...  VARIANTS=deep,raw
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { BASE, environment, heapMb, openPage, otherLoad, r2, startServer, stats } from './lib.mjs';

const only = process.env.ONLY?.split(',');
const want = (s) => !only || only.includes(s);
const RUNS = Number(process.env.RUNS ?? 5); // measured runs; one extra warm-up run is discarded
const THROTTLES = (process.env.THROTTLES ?? '1,4').split(',').map(Number);
const SIZES = process.env.SIZES?.split(',').map(Number);
const VARIANTS = process.env.VARIANTS?.split(',') ?? ['deep', 'raw', 'hybrid', 'class', 'map'];
const MODES = process.env.MODES?.split(',') ?? ['data', 'window', 'list'];
const SIZES_FOR = { data: [1000, 10000, 100000, 250000], window: [1000, 10000, 100000, 250000], list: [1000, 10000, 100000] };
const OPS = ['assign', 'readAll', 'readAll2', 'update', 'update2', 'replace', 'append', 'sort', 'filter'];

const load = await otherLoad();
console.log('other load before the run:', JSON.stringify(load));
const server = await startServer();
const browser = await chromium.launch();
const out = {
	env: environment(browser.version()),
	otherLoad: { before: load },
	method: {
		browser: 'Playwright Chromium (headless), one fresh page per variant x mode x size x throttle',
		runs: `${RUNS} measured runs per configuration after 1 discarded warm-up run; we report median, min and max`,
		timing: {
			js: 'the operation itself (performance.now around the call)',
			dom: 'operation + flushSync(): Svelte has applied every DOM change',
			frame: 'operation until requestAnimationFrame + setTimeout(0): the next frame has been produced (includes style/layout; can include waiting for vsync)'
		},
		memory: 'V8 heap used (CDP Runtime.getHeapUsage) after two forced GCs (CDP HeapProfiler.collectGarbage), minus the same measure taken after the plain rows were created and before they were assigned',
		modes: {
			data: 'no list in the DOM; the page shows a $derived total over every row and the $derived filtered count',
			window: 'a keyed each over the first 50 rows of the $derived filtered list (what a virtual list renders at the top)',
			list: 'a keyed each over every row (7 cells per row)'
		},
		ops: {
			assign: 'list = rows (class: rows.map(r => new RowState(r)); map: new SvelteMap(...))',
			readAll: 'sum row.price + row.owner.id over every row, first time after assign',
			readAll2: 'the same, second time',
			update: 'change one field (price) of row 5; hybrid: first edit promotes the row to $state',
			update2: 'change the same field of the same row again',
			replace: 'replace row 7 with a new object',
			append: 'add one row at the end',
			sort: 'sort by price, descending (deep: in place; raw/hybrid/class: toSorted; map: not applicable)',
			filter: 'set the status filter: the $derived filtered list recomputes (about 1 row in 4 matches)'
		},
		throttle: 'CDP Emulation.setCPUThrottlingRate; 1 = unthrottled, 4 = 4x slower CPU',
		maxList4x: process.env.MAX_LIST_4X ? `full-list configurations at 4x limited to ${process.env.MAX_LIST_4X} rows` : 'all sizes'
	},
	bench: [],
	quiet: [],
	ssr: [],
	hydration: []
};

const save = () => {
	mkdirSync('results', { recursive: true });
	const file = process.env.OUT ?? (only || process.env.SIZES || process.env.RUNS ? `results/measure-partial.json` : 'results/measure.json');
	writeFileSync(file, JSON.stringify(out, null, 2));
	return file;
};

try {
	// 1. The client-side benchmark: every variant, mode, size and throttle.
	if (want('bench')) {
		for (const throttle of THROTTLES) {
			for (const mode of MODES) {
				// MAX_LIST_4X: skip the slowest configurations (full list at 4x above this size; deep 100k took ~15 min).
				const maxList4x = Number(process.env.MAX_LIST_4X ?? Infinity);
				for (const size of (SIZES ?? SIZES_FOR[mode]).filter((s) => !(mode === 'list' && throttle > 1 && s > maxList4x))) {
					for (const variant of VARIANTS) {
						const started = Date.now();
						const { page, cdp } = await openPage(browser, `${BASE}/bench?variant=${variant}&mode=${mode}`, throttle);
						await page.waitForFunction(() => window.__bench);
						const runs = [];
						for (let r = 0; r <= RUNS; r++) {
							await page.evaluate((n) => window.__bench.prepare(n), size);
							const base = await heapMb(cdp);
							const t = {};
							const heap = {};
							const check = {};
							for (const op of OPS) {
								t[op] = await page.evaluate((o) => window.__bench.op(o), op);
								if (op === 'assign') heap.afterAssign = (await heapMb(cdp)) - base;
								if (op === 'readAll2') heap.afterReadAll = (await heapMb(cdp)) - base;
								if (op === 'update2' || op === 'filter') check[op] = await page.evaluate(() => window.__bench.dom());
							}
							if (r > 0) runs.push({ t, heap, check });
						}
						await page.evaluate(() => window.__bench.cleanup());
						await page.context().close();
						const entry = { variant, mode, size, throttle, ops: {}, heapMb: {}, check: runs[0].check };
						for (const op of OPS) {
							const err = runs.find((x) => x.t[op]?.error)?.t[op].error;
							entry.ops[op] = err
								? { error: err.includes('not applicable') ? 'not applicable' : err }
								: { js: stats(runs.map((x) => x.t[op].js)), dom: stats(runs.map((x) => x.t[op].dom)), frame: stats(runs.map((x) => x.t[op].frame)) };
						}
						entry.heapMb.afterAssign = stats(runs.map((x) => x.heap.afterAssign));
						entry.heapMb.afterReadAll = stats(runs.map((x) => x.heap.afterReadAll));
						entry.seconds = Math.round((Date.now() - started) / 1000);
						out.bench.push(entry);
						const d = (op) => entry.ops[op].dom?.median ?? '-';
						console.log(
							`${throttle}x ${mode.padEnd(6)} ${String(size).padStart(6)} ${variant.padEnd(6)} assign ${d('assign')}  read ${d('readAll')}/${d('readAll2')}  upd ${d('update')}/${d('update2')}  repl ${d('replace')}  app ${d('append')}  sort ${d('sort')}  filt ${d('filter')}  heap ${entry.heapMb.afterAssign?.median}/${entry.heapMb.afterReadAll?.median} MB  (${entry.seconds}s)`
						);
						save();
					}
				}
			}
		}
	}

	// 2. Lazy or eager? A big list that nothing renders: assign, then read it, heap after each step.
	if (want('quiet')) {
		for (const size of SIZES ?? [10000, 100000, 250000]) {
			for (const kind of ['deep', 'raw']) {
				const { page, cdp } = await openPage(browser, `${BASE}/gotchas`, 1);
				await page.waitForFunction(() => window.__gotchas);
				const g = (fn, ...a) => page.evaluate(([f, args]) => window.__gotchas[f](...args), [fn, a]);
				const runs = [];
				for (let r = 0; r <= RUNS; r++) {
					await g('quietPrepare', kind, size);
					const base = await heapMb(cdp);
					const x = { assignMs: await g('quietAssign') };
					x.heapAfterAssign = (await heapMb(cdp)) - base;
					x.read1Ms = await g('quietRead');
					x.heapAfterRead1 = (await heapMb(cdp)) - base;
					x.read2Ms = await g('quietRead');
					x.snapshotAfterReadMs = await g('quietSnapshot');
					x.structuredCloneMs = await g('quietStructuredClone');
					// Snapshot of a list nobody has read yet
					await g('quietPrepare', kind, size);
					await g('quietAssign');
					x.snapshotUnreadMs = await g('quietSnapshot');
					await g('quietClear');
					if (r > 0) runs.push(x);
				}
				await page.context().close();
				const keys = Object.keys(runs[0]);
				const entry = { kind, size, throttle: 1 };
				for (const k of keys) entry[k] = typeof runs[0][k] === 'number' ? stats(runs.map((x) => x[k])) : runs[0][k];
				out.quiet.push(entry);
				console.log(`quiet ${kind.padEnd(4)} ${String(size).padStart(6)} assign ${entry.assignMs.median} ms  heap ${entry.heapAfterAssign.median} MB  read1 ${entry.read1Ms.median} ms  heap ${entry.heapAfterRead1.median} MB  read2 ${entry.read2Ms.median} ms  snapshot ${entry.snapshotAfterReadMs.median}/${entry.snapshotUnreadMs.median} ms  structuredClone ${JSON.stringify(entry.structuredCloneMs?.median ?? entry.structuredCloneMs)}`);
				save();
			}
		}
	}

	// 3. Server render time: the same list in $state and $state.raw, on `node build`.
	if (want('ssr')) {
		for (const size of SIZES ?? [1000, 10000, 50000]) {
			const times = { deep: [], raw: [] };
			let bytes = {};
			for (let i = 0; i < 35; i++) {
				for (const kind of ['deep', 'raw']) {
					const t0 = performance.now();
					const res = await fetch(`${BASE}/ssr/${kind}?n=${size}`);
					const html = await res.text();
					const ms = performance.now() - t0;
					bytes[kind] = html.length;
					if (i >= 5) times[kind].push(ms); // 5 warm-up requests
				}
			}
			for (const kind of ['deep', 'raw']) out.ssr.push({ kind, size, requests: times[kind].length, responseMs: stats(times[kind]), htmlBytes: bytes[kind] });
			console.log(`ssr ${String(size).padStart(6)} deep ${stats(times.deep).median} ms  raw ${stats(times.raw).median} ms  (${bytes.deep} bytes)`);
			save();
		}
	}

	// 4. Hydration of the server-rendered list in the browser.
	if (want('hydration')) {
		for (const throttle of THROTTLES) {
			for (const size of SIZES ?? [1000, 10000]) {
				for (const kind of ['deep', 'raw']) {
					const times = [];
					for (let r = 0; r <= RUNS; r++) {
						const { page } = await openPage(browser, `${BASE}/ssr/${kind}?n=${size}`, throttle);
						await page.waitForFunction(() => window.__hydratedAt, null, { timeout: 120000 });
						const ms = await page.evaluate(() => window.__hydratedAt);
						await page.context().close();
						if (r > 0) times.push(ms);
					}
					out.hydration.push({ kind, size, throttle, hydratedAtMs: stats(times) });
					console.log(`hydration ${throttle}x ${String(size).padStart(6)} ${kind} ${stats(times).median} ms`);
					save();
				}
			}
		}
	}
} finally {
	await browser.close();
	server.kill();
}

out.otherLoad.after = await otherLoad();
out.env.finished = new Date().toISOString();
console.log('other load after the run:', JSON.stringify(out.otherLoad.after));
console.log('\nwrote ' + save());
