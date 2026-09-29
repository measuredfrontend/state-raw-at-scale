// Summary numbers derived from results/measure.json (and the earlier run under load).
//   node scripts/compare.mjs  ->  results/summary.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const m = JSON.parse(readFileSync('results/measure.json', 'utf8'));
const key = (e) => `${e.throttle}x ${e.mode} ${e.size} ${e.variant}`;
const out = { source: 'results/measure.json', date: m.env.date };

// 1. At 1,000 rows: the largest difference between variants, per throttle and page shape.
out.at1k = {};
for (const e of m.bench.filter((x) => x.size === 1000)) {
	const k = `${e.throttle}x ${e.mode}`;
	for (const [op, o] of Object.entries(e.ops)) {
		if (!o.dom) continue;
		const cur = (out.at1k[k] ??= { maxMs: 0, maxOp: null, maxDiff: 0, diffOp: null, byOp: {} });
		(cur.byOp[op] ??= []).push([e.variant, o.dom.median]);
		if (o.dom.median > cur.maxMs) Object.assign(cur, { maxMs: o.dom.median, maxOp: `${op} (${e.variant})` });
	}
}
for (const cur of Object.values(out.at1k)) {
	for (const [op, vals] of Object.entries(cur.byOp)) {
		const ms = vals.map((v) => v[1]);
		const diff = Math.max(...ms) - Math.min(...ms);
		if (diff > cur.maxDiff) Object.assign(cur, { maxDiff: Math.round(diff * 10) / 10, diffOp: op });
	}
	delete cur.byOp;
}

// 2. Ratio deep / raw for full reads (readAll2) per size and throttle.
out.fullReadRatio = m.bench
	.filter((e) => e.mode === 'data' && e.variant === 'deep')
	.map((d) => {
		const r = m.bench.find((x) => x.mode === 'data' && x.variant === 'raw' && x.size === d.size && x.throttle === d.throttle);
		return { throttle: d.throttle, size: d.size, deepMs: d.ops.readAll2.dom.median, rawMs: r.ops.readAll2.dom.median, ratio: Math.round(d.ops.readAll2.dom.median / Math.max(r.ops.readAll2.dom.median, 0.1)) };
	});

// 3. Agreement with the earlier run under load (same code): relative difference of medians >= 1 ms.
if (existsSync('results/measure-under-load.json')) {
	const u = JSON.parse(readFileSync('results/measure-under-load.json', 'utf8'));
	const diffs = [];
	for (const e of m.bench) {
		const o = u.bench.find((x) => key(x) === key(e));
		if (!o) continue;
		for (const [op, v] of Object.entries(e.ops)) {
			const a = v.dom?.median;
			const b = o.ops[op]?.dom?.median;
			if (a >= 1 && b >= 1) diffs.push(Math.abs(a - b) / a);
		}
	}
	diffs.sort((a, b) => a - b);
	const q = (p) => Math.round(100 * diffs[Math.floor(p * (diffs.length - 1))]);
	out.vsUnderLoad = { comparedMedians: diffs.length, medianDiffPercent: q(0.5), p90DiffPercent: q(0.9), within15Percent: Math.round((100 * diffs.filter((d) => d <= 0.15).length) / diffs.length) };
}
writeFileSync('results/summary.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
