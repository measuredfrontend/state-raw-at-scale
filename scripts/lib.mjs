// Shared helpers for measure.mjs and pack-tests.mjs.
// Always the production build on the real Node adapter (`node build`), never the dev server.
import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

export const PORT = Number(process.env.PORT ?? 4304);
export const BASE = `http://127.0.0.1:${PORT}`;

export async function startServer() {
	const server = spawn(process.execPath, ['build'], {
		env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let log = '';
	server.stdout.on('data', (d) => (log += d));
	server.stderr.on('data', (d) => (log += d));
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(BASE + '/');
			if (r.ok) return server;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	server.kill();
	throw new Error('server did not start. Run `bun run build` first.\n' + log);
}

export const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const r2 = (x) => Math.round(x * 100) / 100;

/** Median, min and max of a list of numbers (the spread we report). */
export function stats(xs) {
	const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
	if (!v.length) return null;
	return { median: r2(median(v)), min: r2(Math.min(...v)), max: r2(Math.max(...v)), n: v.length };
}

/** Busy share of all cores over `ms`, from os.cpus() tick counters. */
export async function cpuBusy(ms = 2000) {
	const snap = () => os.cpus().reduce((a, c) => {
		const t = c.times;
		a.idle += t.idle;
		a.total += t.user + t.nice + t.sys + t.idle + t.irq;
		return a;
	}, { idle: 0, total: 0 });
	const a = snap();
	await new Promise((r) => setTimeout(r, ms));
	const b = snap();
	return r2(100 * (1 - (b.idle - a.idle) / (b.total - a.total)));
}

/** Other load on the machine: python (voice model) processes and CPU busy % before the run. */
export async function otherLoad() {
	let python = [];
	try {
		const out = execSync('powershell -NoProfile -Command "Get-Process python -ErrorAction SilentlyContinue | Select-Object Id,CPU | ConvertTo-Json -Compress"', { encoding: 'utf8' }).trim();
		if (out) python = [].concat(JSON.parse(out));
	} catch {}
	let gpu = null;
	try {
		gpu = execSync('nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader', { encoding: 'utf8' }).trim();
	} catch {}
	return { pythonProcesses: python.length, python, cpuBusyPercentBefore: await cpuBusy(), gpu };
}

export function environment(browserVersion) {
	const pkg = (name) => {
		try {
			return JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
		} catch {
			return null;
		}
	};
	return {
		date: new Date().toISOString(),
		node: process.version,
		os: `${os.type()} ${os.release()}`,
		cpu: os.cpus()[0]?.model?.trim(),
		cores: os.cpus().length,
		ramGb: Math.round(os.totalmem() / 2 ** 30),
		svelte: pkg('svelte'),
		kit: pkg('@sveltejs/kit'),
		adapterNode: pkg('@sveltejs/adapter-node'),
		vite: pkg('vite'),
		playwright: pkg('playwright'),
		chromium: browserVersion ?? null,
		server: `node build (adapter-node), production build, ${BASE}`
	};
}

/** Force a full GC in the page and read the V8 heap (CDP). Returns MB. */
export async function heapMb(cdp) {
	await cdp.send('HeapProfiler.collectGarbage');
	await cdp.send('HeapProfiler.collectGarbage');
	const { usedSize } = await cdp.send('Runtime.getHeapUsage');
	return usedSize / 2 ** 20;
}

/** A fresh page with its own CDP session and the given CPU throttle. */
export async function openPage(browser, url, throttle = 1) {
	const page = await browser.newPage();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('HeapProfiler.enable');
	if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
	await page.goto(url);
	return { page, cdp };
}
