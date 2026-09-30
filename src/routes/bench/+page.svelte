<script lang="ts">
	import { flushSync } from 'svelte';
	import { page } from '$app/state';
	import { makeRow, makeRows, type Row } from '$lib/rows';
	import { createList, DeepList, readAll, type Variant } from '$lib/stores.svelte';
	import RowView from '$lib/RowView.svelte';

	// /bench?variant=deep|raw|hybrid|class|map&mode=data|list|window
	const variant = (page.url.searchParams.get('variant') ?? 'deep') as Variant;
	const mode = page.url.searchParams.get('mode') ?? 'data';
	const WINDOW = 50;

	const list = createList(variant);
	let filter = $state<Row['status'] | null>(null);

	// "filter via $derived": what a search box or a status tab does.
	const visible = $derived(filter ? list.items.filter((r) => r.status === filter) : list.items);
	// "read all inside $derived": a total that depends on every row (data mode only).
	const total = $derived(mode === 'data' ? readAll(list.items) : 0);
	const shown = $derived(mode === 'window' ? visible.slice(0, WINDOW) : visible);

	let rows: Row[] = [];
	let spare: Row[] = [];

	/** Time one change: JS, until Svelte has updated the DOM (flushSync), and until the next frame. */
	async function timed(fn: () => unknown) {
		const t0 = performance.now();
		fn();
		const t1 = performance.now();
		flushSync();
		const t2 = performance.now();
		await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
		const t3 = performance.now();
		return { js: t1 - t0, dom: t2 - t0, frame: t3 - t0 };
	}

	const ops: Record<string, () => unknown> = {
		assign: () => list.assign(rows),
		readAll: () => readAll(list.items),
		readAll2: () => readAll(list.items),
		update: () => list.updatePrice(5, 1.23),
		update2: () => list.updatePrice(5, 4.56),
		replace: () => list.replace(7, spare[0]),
		append: () => list.append(spare[1]),
		sort: () => list.sortByPrice(),
		// $state only: sort as a copy + reassignment (measured on a fresh, unsorted list)
		sortCopy: () => (list instanceof DeepList ? list.sortByPriceCopy() : list.sortByPrice()),
		filter: () => (filter = 'late')
	};

	const api = {
		variant,
		mode,
		/** Build the plain data (not timed) and empty the list. */
		prepare(n: number) {
			filter = null;
			list.assign([]);
			flushSync();
			rows = makeRows(n, 1);
			spare = [makeRow(n + 1, () => 0.9), makeRow(n + 2, () => 0.9)]; // status 'void'
		},
		async op(name: string) {
			try {
				return await timed(ops[name]);
			} catch (e) {
				return { error: String(e) };
			}
		},
		/** What is on screen, for correctness checks. */
		dom() {
			const trs = document.querySelectorAll('#list tr');
			return {
				rows: trs.length,
				first: trs[0]?.textContent ?? null,
				row5: document.querySelector('[data-id="5"]')?.textContent ?? null,
				stats: document.querySelector('#stats')?.textContent ?? null
			};
		},
		cleanup() {
			rows = [];
			spare = [];
		}
	};
	(window as any).__bench = api;
</script>

<h1>{variant} · {mode}</h1>
{#if mode === 'data'}
	<p id="stats">total {total.toFixed(2)} · rows {visible.length}</p>
{:else}
	<p id="stats">rows {visible.length}</p>
	<table id="list">
		<tbody>
			{#each shown as row (row.id)}
				<RowView {row} />
			{/each}
		</tbody>
	</table>
{/if}
