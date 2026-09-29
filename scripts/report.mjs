// Turns results/measure.json into the Markdown tables used in the README (results/report.md).
//   node scripts/report.mjs [results/measure.json]
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'results/measure.json';
const m = JSON.parse(readFileSync(file, 'utf8'));
const V = ['deep', 'raw', 'hybrid', 'class', 'map'];
const k = (n) => (n >= 1000 ? `${n / 1000}k` : String(n));
const fmt = (s) => (s == null ? 'n/a' : s.median < 10 ? s.median.toFixed(1) : String(Math.round(s.median)));
const spread = (s) => (s == null ? '' : ` (${s.min < 10 ? s.min.toFixed(1) : Math.round(s.min)}–${s.max < 10 ? s.max.toFixed(1) : Math.round(s.max)})`);
const find = (mode, size, variant, throttle) => m.bench.find((e) => e.mode === mode && e.size === size && e.variant === variant && e.throttle === throttle);
const lines = [];
const p = (s = '') => lines.push(s);

p(`# Report: ${file}`);
p();
p(`Run ${m.env.date} → ${m.env.finished ?? '?'} · Svelte ${m.env.svelte} · Kit ${m.env.kit} · Chromium ${m.env.chromium} · ${m.env.cpu} · Node ${m.env.node}`);
p(`Other load before: ${m.otherLoad.before.pythonProcesses} python processes, CPU busy ${m.otherLoad.before.cpuBusyPercentBefore}%, GPU ${m.otherLoad.before.gpu}. After: ${m.otherLoad.after?.pythonProcesses} python, CPU ${m.otherLoad.after?.cpuBusyPercentBefore}%.`);
p();
p('All times: median ms until the DOM is updated (`dom`), min–max of the runs in brackets where shown.');

const throttles = [...new Set(m.bench.map((e) => e.throttle))];
const modes = [...new Set(m.bench.map((e) => e.mode))];
for (const throttle of throttles) {
	for (const mode of modes) {
		const sizes = [...new Set(m.bench.filter((e) => e.mode === mode && e.throttle === throttle).map((e) => e.size))];
		for (const op of ['assign', 'readAll', 'readAll2', 'update', 'update2', 'replace', 'append', 'sort', 'filter']) {
			p();
			p(`### ${mode} · ${op} · ${throttle}x CPU`);
			p();
			p(`| rows | ${V.join(' | ')} |`);
			p(`| --- | ${V.map(() => '---').join(' | ')} |`);
			for (const size of sizes) {
				p(`| ${k(size)} | ${V.map((v) => { const e = find(mode, size, v, throttle); const o = e?.ops[op]; return o?.error ? 'n/a' : o ? fmt(o.dom) + spread(o.dom) : ''; }).join(' | ')} |`);
			}
		}
		p();
		p(`### ${mode} · next frame after assign (includes layout) · ${throttle}x CPU`);
		p();
		p(`| rows | ${V.join(' | ')} |`);
		p(`| --- | ${V.map(() => '---').join(' | ')} |`);
		for (const size of sizes) p(`| ${k(size)} | ${V.map((v) => fmt(find(mode, size, v, throttle)?.ops.assign.frame)).join(' | ')} |`);
		p();
		p(`### ${mode} · heap MB after assign + read all (forced GC) · ${throttle}x CPU`);
		p();
		p(`| rows | ${V.join(' | ')} |`);
		p(`| --- | ${V.map(() => '---').join(' | ')} |`);
		for (const size of sizes) p(`| ${k(size)} | ${V.map((v) => { const h = find(mode, size, v, throttle)?.heapMb; return h ? `${fmt(h.afterAssign)} / ${fmt(h.afterReadAll)}` : ''; }).join(' | ')} |`);
	}
}

// Per-row cost of a full read through the proxy, and where it crosses one frame.
p();
p('### Full read per row (data mode, readAll2, µs per row) and rows at which one full read takes 16.7 ms');
p();
p('| throttle | deep µs/row | raw µs/row | deep: rows per 16.7 ms | measured size where deep `update` (with a $derived total) first exceeds 16.7 ms |');
p('| --- | --- | --- | --- | --- |');
for (const throttle of throttles) {
	const big = Math.max(...m.bench.filter((e) => e.mode === 'data' && e.throttle === throttle).map((e) => e.size));
	const d = find('data', big, 'deep', throttle);
	const r = find('data', big, 'raw', throttle);
	const us = (e) => (1000 * e.ops.readAll2.dom.median) / e.size;
	const first = m.bench.filter((e) => e.mode === 'data' && e.variant === 'deep' && e.throttle === throttle && e.ops.update.dom.median > 16.7).map((e) => e.size).sort((a, b) => a - b)[0];
	p(`| ${throttle}x | ${us(d).toFixed(2)} | ${us(r).toFixed(3)} | ${Math.round(16700 / us(d)).toLocaleString('en')} | ${first ? k(first) : 'none'} |`);
}

if (m.quiet?.length) {
	p();
	p('### Lazy proxies: a list nothing renders (1x CPU)');
	p();
	p('| kind | rows | assign ms | heap after assign MB | first read ms | heap after first read MB | second read ms | snapshot (read) ms | snapshot (unread) ms | structuredClone ms |');
	p('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const q of m.quiet) p(`| ${q.kind} | ${k(q.size)} | ${fmt(q.assignMs)} | ${fmt(q.heapAfterAssign)} | ${fmt(q.read1Ms)} | ${fmt(q.heapAfterRead1)} | ${fmt(q.read2Ms)} | ${fmt(q.snapshotAfterReadMs)} | ${fmt(q.snapshotUnreadMs)} | ${typeof q.structuredCloneMs === 'string' ? 'throws' : fmt(q.structuredCloneMs)} |`);
}
if (m.ssr?.length) {
	p();
	p('### Server render (node build, full response, 30 requests after 5 warm-up)');
	p();
	p('| rows | $state ms | $state.raw ms | HTML |');
	p('| --- | --- | --- | --- |');
	for (const size of [...new Set(m.ssr.map((s) => s.size))]) {
		const d = m.ssr.find((s) => s.size === size && s.kind === 'deep');
		const r = m.ssr.find((s) => s.size === size && s.kind === 'raw');
		p(`| ${k(size)} | ${fmt(d.responseMs)}${spread(d.responseMs)} | ${fmt(r.responseMs)}${spread(r.responseMs)} | ${(d.htmlBytes / 1e6).toFixed(2)} MB |`);
	}
}
if (m.hydration?.length) {
	p();
	p('### Hydration of the server-rendered list (ms from navigation start to onMount)');
	p();
	p('| throttle | rows | $state | $state.raw |');
	p('| --- | --- | --- | --- |');
	for (const h of m.hydration.filter((x) => x.kind === 'deep')) {
		const r = m.hydration.find((x) => x.kind === 'raw' && x.size === h.size && x.throttle === h.throttle);
		p(`| ${h.throttle}x | ${k(h.size)} | ${fmt(h.hydratedAtMs)}${spread(h.hydratedAtMs)} | ${fmt(r?.hydratedAtMs)}${spread(r?.hydratedAtMs)} |`);
	}
}
const out = file.replace(/\.json$/, '.report.md');
writeFileSync(out, lines.join('\n') + '\n');
console.log('wrote ' + out);
