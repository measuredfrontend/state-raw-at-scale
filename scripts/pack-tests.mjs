// Tests that back every rule in the Measured Rules pack: a rule without a passing test doesn't ship.
//   bun run build && bun run test:pack
// Each test states the behaviour a rule depends on. Timing tests compare variants on the
// same machine in the same run (ratios, not absolute numbers), with wide margins.
// If a Svelte release changes the behaviour, the test fails and the rule gets reviewed.
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BASE, environment, heapMb, median, openPage, otherLoad, r2, startServer } from './lib.mjs';

const RUNS = 3;
const results = [];
async function test(id, rule, title, fn) {
	try {
		const detail = await fn();
		results.push({ id, rule, title, pass: true, detail });
		console.log(`PASS ${id} (${rule}) ${title}  ${JSON.stringify(detail)}`);
	} catch (e) {
		results.push({ id, rule, title, pass: false, detail: String(e.message ?? e) });
		console.log(`FAIL ${id} (${rule}) ${title}  ${e.message ?? e}`);
	}
}
function expect(cond, msg) {
	if (!cond) throw new Error(msg);
}

/** Median `dom` time (ms) of each op for one variant/mode/size, plus heap after readAll. */
async function bench(browser, variant, mode, size, ops) {
	const { page, cdp } = await openPage(browser, `${BASE}/bench?variant=${variant}&mode=${mode}`);
	await page.waitForFunction(() => window.__bench);
	const t = Object.fromEntries(ops.map((o) => [o, []]));
	const heap = [];
	for (let r = 0; r <= RUNS; r++) {
		await page.evaluate((n) => window.__bench.prepare(n), size);
		const base = await heapMb(cdp);
		for (const op of ops) {
			const x = await page.evaluate((o) => window.__bench.op(o), op);
			if (r > 0 && typeof x.dom === 'number') t[op].push(x.dom); // map: sort is not applicable
			if (op === 'readAll2' && r > 0) heap.push((await heapMb(cdp)) - base);
		}
	}
	await page.context().close();
	const res = Object.fromEntries(ops.filter((o) => t[o].length).map((o) => [o, r2(median(t[o]))]));
	if (heap.length) res.heapMb = r2(median(heap));
	return res;
}

async function gotchas(browser) {
	const { page, cdp } = await openPage(browser, `${BASE}/gotchas`);
	await page.waitForFunction(() => window.__gotchas);
	const g = (fn, ...a) => page.evaluate(([f, args]) => window.__gotchas[f](...args), [fn, a]);
	return { page, cdp, g };
}

const load = await otherLoad();
const server = await startServer();
const browser = await chromium.launch();

const DATA_OPS = ['assign', 'readAll', 'readAll2', 'update', 'update2', 'replace', 'append', 'sort', 'filter'];
try {
	await test('T1', 'rule 1', "at 1,000 rows, list rendered, unthrottled: every operation of every variant finishes Svelte's DOM update within 16.7 ms (style and layout not included)", async () => {
		const worst = {};
		for (const variant of ['deep', 'raw', 'hybrid', 'class', 'map']) {
			const b = await bench(browser, variant, 'list', 1000, DATA_OPS);
			delete b.heapMb;
			const [op, ms] = Object.entries(b).sort((a, c) => c[1] - a[1])[0];
			worst[variant] = `${op} ${ms} ms`;
			expect(ms < 16.7, `${variant}: ${op} took ${ms} ms`);
		}
		return worst;
	});

	await test('T2', 'rule 2', 'at 100,000 rows with a $derived total, assign + the first $derived full read costs at least 10x more with $state than with $state.raw, and uses 50+ MB more heap', async () => {
		const deep = await bench(browser, 'deep', 'data', 100000, ['assign', 'readAll', 'readAll2']);
		const raw = await bench(browser, 'raw', 'data', 100000, ['assign', 'readAll', 'readAll2']);
		expect(deep.assign >= 10 * raw.assign, `assign deep ${deep.assign} ms vs raw ${raw.assign} ms`);
		expect(deep.heapMb - raw.heapMb >= 50, `heap deep ${deep.heapMb} MB vs raw ${raw.heapMb} MB`);
		return { assignMs: { deep: deep.assign, raw: raw.assign }, heapMb: { deep: deep.heapMb, raw: raw.heapMb } };
	});

	await test('T3', 'rule 3', '$state.raw mutated in place: the screen does not change; a new array shows the pushed row but NOT the edited field; only a new object for that row shows it', async () => {
		const { page, g } = await gotchas(browser);
		const r = await g('rawInPlace');
		await page.context().close();
		const first = (s) => s.split(',')[0];
		expect(r.before === r.afterMutation, `screen changed after in-place mutation: ${r.before} -> ${r.afterMutation}`);
		expect(r.afterNewArray.split(',').length === 4 && first(r.afterNewArray) === first(r.before), `after new array: ${r.afterNewArray}`);
		expect(first(r.afterNewRowObject) === '999', `after new row object: ${r.afterNewRowObject}`);
		return r;
	});

	await test('T4', 'rule 4', '$state creates proxies lazily: assigning 100,000 unread rows is under 5 ms and adds under 1 MB; the first full read adds 50+ MB and is slower than the second', async () => {
		const { page, cdp, g } = await gotchas(browser);
		const runs = [];
		for (let r = 0; r <= RUNS; r++) {
			await g('quietPrepare', 'deep', 100000);
			const base = await heapMb(cdp);
			const assignMs = await g('quietAssign');
			const heapAssign = (await heapMb(cdp)) - base;
			const read1 = await g('quietRead');
			const heapRead = (await heapMb(cdp)) - base;
			const read2 = await g('quietRead');
			await g('quietClear');
			if (r > 0) runs.push({ assignMs, heapAssign, read1, heapRead, read2 });
		}
		await page.context().close();
		const m = (k) => r2(median(runs.map((x) => x[k])));
		const d = { assignMs: m('assignMs'), heapAfterAssignMb: m('heapAssign'), read1Ms: m('read1'), heapAfterReadMb: m('heapRead'), read2Ms: m('read2') };
		expect(d.assignMs < 5 && d.heapAfterAssignMb < 1, `assign ${d.assignMs} ms, ${d.heapAfterAssignMb} MB`);
		expect(d.heapAfterReadMb >= 50 && d.read1Ms > d.read2Ms, `read1 ${d.read1Ms} ms, ${d.heapAfterReadMb} MB, read2 ${d.read2Ms} ms`);
		return d;
	});

	await test('T5', 'rule 5', 'hybrid: the first edit of a row swaps in a $state proxy (new array); later edits change only that row (same array) and update the screen', async () => {
		const { page, g } = await gotchas(browser);
		const r = await g('fineGrained');
		await page.context().close();
		expect(r.hybridArrayReplacedOnFirstEdit && r.hybridArrayKeptOnSecondEdit, JSON.stringify(r));
		expect(r.hybrid.split(',')[1] === '22', `hybrid screen: ${r.hybrid}`);
		expect(r.classArrayKept && r.klass.split(',')[1] === '33', `class: ${r.klass}`);
		expect(r.deep.split(',')[1] === '44', `deep: ${r.deep}`);
		return r;
	});

	await test('T6', 'rule 5', 'at 100,000 rows (windowed list), repeated edits of one row: hybrid is at least 3x faster than an immutable copy with $state.raw', async () => {
		const ops = ['assign', 'update', 'update2'];
		const raw = await bench(browser, 'raw', 'window', 100000, ops);
		const hybrid = await bench(browser, 'hybrid', 'window', 100000, ops);
		// hybrid is often below the timer resolution (~0.1 ms): compare against at least 0.1 ms
		expect(raw.update2 >= 3 * Math.max(hybrid.update2, 0.1), `update2 raw ${raw.update2} ms vs hybrid ${hybrid.update2} ms`);
		return { update2Ms: { raw: raw.update2, hybrid: hybrid.update2 }, firstEditMs: { raw: raw.update, hybrid: hybrid.update } };
	});

	await test('T7', 'rule 6', 'a $state array does not return the objects you put in: identity checks fail, writes through it do not reach the original', async () => {
		const { page, g } = await gotchas(browser);
		const r = await g('identity');
		await page.context().close();
		expect(r.deepSameObject === false && r.deepIncludes === false && r.deepIndexOf === -1, JSON.stringify(r));
		expect(r.deepFindById === 0 && r.rawSameObject && r.rawIncludes, JSON.stringify(r));
		expect(r.originalAfterProxyWrite !== 1 && r.proxyAfterProxyWrite === 1, JSON.stringify(r));
		return r;
	});

	await test('T8', 'rule 7', '$state.snapshot of 10,000 rows is at least 2x slower than structuredClone of the same plain rows, and snapshotting an unread $state list is slower still', async () => {
		const { page, g } = await gotchas(browser);
		const runs = [];
		for (let r = 0; r <= RUNS; r++) {
			await g('quietPrepare', 'raw', 10000);
			await g('quietAssign');
			const snapRaw = await g('quietSnapshot');
			const clone = await g('quietStructuredClone');
			await g('quietPrepare', 'deep', 10000);
			await g('quietAssign');
			const snapDeepUnread = await g('quietSnapshot');
			await g('quietClear');
			if (r > 0) runs.push({ snapRaw, clone, snapDeepUnread });
		}
		await page.context().close();
		const m = (k) => r2(median(runs.map((x) => x[k])));
		const d = { snapshotRawMs: m('snapRaw'), structuredCloneMs: m('clone'), snapshotDeepUnreadMs: m('snapDeepUnread') };
		expect(d.snapshotRawMs >= 2 * d.structuredCloneMs, JSON.stringify(d));
		expect(d.snapshotDeepUnreadMs > d.snapshotRawMs, JSON.stringify(d));
		return d;
	});

	await test('T9', 'rule 8', 'server render: $state and $state.raw compile to the same server code, and render 10,000 rows within 15% of each other', async () => {
		const dir = '.svelte-kit/output/server/entries/pages/ssr';
		const code = (k) => readFileSync(join(dir, k, '_page.svelte.js'), 'utf8');
		const deepCode = code('deep').match(/const items = (.+);/)?.[1];
		const rawCode = code('raw').match(/const items = (.+);/)?.[1];
		expect(deepCode && deepCode === rawCode && !/proxy|\$state/.test(deepCode), `deep: ${deepCode}, raw: ${rawCode}`);
		const times = { deep: [], raw: [] };
		for (let i = 0; i < 25; i++) {
			for (const k of ['deep', 'raw']) {
				const t0 = performance.now();
				await (await fetch(`${BASE}/ssr/${k}?n=10000`)).text();
				if (i >= 5) times[k].push(performance.now() - t0);
			}
		}
		const deep = r2(median(times.deep));
		const raw = r2(median(times.raw));
		expect(Math.abs(deep - raw) / raw <= 0.15, `deep ${deep} ms vs raw ${raw} ms`);
		return { serverCode: deepCode, responseMs: { deep, raw } };
	});

	await test('T10', 'rule 2', 'rendering 10,000 rows (keyed each, full list): $state takes at least 2x as long as $state.raw', async () => {
		const deep = await bench(browser, 'deep', 'list', 10000, ['assign']);
		const raw = await bench(browser, 'raw', 'list', 10000, ['assign']);
		expect(deep.assign >= 2 * raw.assign, `deep ${deep.assign} ms vs raw ${raw.assign} ms`);
		return { renderMs: { deep: deep.assign, raw: raw.assign } };
	});

	await test('T11', 'rule 2', 'sorting 100,000 rows (data page): on $state, both in place and as toSorted + reassignment, is at least 3x slower than toSorted on $state.raw', async () => {
		const deep = await bench(browser, 'deep', 'data', 100000, ['assign', 'sort']);
		const deepCopy = await bench(browser, 'deep', 'data', 100000, ['assign', 'sortCopy']);
		const raw = await bench(browser, 'raw', 'data', 100000, ['assign', 'sort']);
		expect(deep.sort >= 3 * raw.sort, `in place: deep ${deep.sort} ms vs raw ${raw.sort} ms`);
		expect(deepCopy.sortCopy >= 3 * raw.sort, `copy: deep ${deepCopy.sortCopy} ms vs raw ${raw.sort} ms`);
		return { sortMs: { deepInPlace: deep.sort, deepToSorted: deepCopy.sortCopy, raw: raw.sort } };
	});

	await test('T12', 'rule 2', 'at 10,000 rows with a $derived total and 4x CPU throttling, one edit on $state takes at least 5x as long as on $state.raw', async () => {
		const one = async (variant) => {
			const { page, cdp } = await openPage(browser, `${BASE}/bench?variant=${variant}&mode=data`, 4);
			await page.waitForFunction(() => window.__bench);
			const xs = [];
			for (let r = 0; r <= RUNS; r++) {
				await page.evaluate((n) => window.__bench.prepare(n), 10000);
				await page.evaluate(() => window.__bench.op('assign'));
				const x = await page.evaluate(() => window.__bench.op('update'));
				if (r > 0) xs.push(x.dom);
			}
			await page.context().close();
			return r2(median(xs));
		};
		const deep = await one('deep');
		const raw = await one('raw');
		expect(deep >= 5 * Math.max(raw, 0.1), `deep ${deep} ms vs raw ${raw} ms`);
		return { editMs4x: { deep, raw } };
	});

	await test('T13', 'rule 4', 'windowed list (50 of 100,000 rows rendered): an edit on $state is no slower than on $state.raw, but a sort on $state is at least 3x slower', async () => {
		const ops = ['assign', 'update', 'update2', 'sort'];
		const deep = await bench(browser, 'deep', 'window', 100000, ops);
		const raw = await bench(browser, 'raw', 'window', 100000, ops);
		expect(deep.update2 <= raw.update2 * 1.5 + 0.2, `edit: deep ${deep.update2} ms vs raw ${raw.update2} ms`);
		expect(deep.sort >= 3 * raw.sort, `sort: deep ${deep.sort} ms vs raw ${raw.sort} ms`);
		return { editMs: { deep: deep.update2, raw: raw.update2 }, sortMs: { deep: deep.sort, raw: raw.sort } };
	});

	await test('T14', 'rule 5', 'hybrid: a promoted row replaced by a new object with the same id is promoted again on its next edit, and the screen updates', async () => {
		const { page, g } = await gotchas(browser);
		const r = await g('hybridSameId');
		await page.context().close();
		expect(r.afterReplace.split(',')[1] === '5' && r.afterEdit.split(',')[1] === '77', JSON.stringify(r));
		return r;
	});
} finally {
	await browser.close();
	server.kill();
}

mkdirSync('results', { recursive: true });
writeFileSync('results/pack-tests.json', JSON.stringify({ env: environment(browser.version?.() ?? null), otherLoad: load, results }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
