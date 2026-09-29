<script lang="ts">
	import { flushSync } from 'svelte';
	import { makeRow, makeRows, type Row } from '$lib/rows';
	import { DeepList, RawList, HybridList, ClassList, readAll } from '$lib/stores.svelte';

	// Small lists that ARE rendered, for behaviour checks.
	const shownRaw = new RawList();
	const shownDeep = new DeepList();
	const shownHybrid = new HybridList();
	const shownClass = new ClassList();

	// Big lists that are NOT rendered: nothing reads them unless a check does.
	let quiet: DeepList | RawList = new DeepList();
	let quietRows: Row[] = [];

	const text = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.textContent).join(',');

	/** Time a function in ms. */
	function time<T>(fn: () => T) {
		const t0 = performance.now();
		const value = fn();
		return { ms: performance.now() - t0, value };
	}

	const api = {
		/** `$state.raw` mutated in place: does the screen change? */
		rawInPlace() {
			shownRaw.assign(makeRows(3, 7));
			flushSync();
			const before = text('.raw-row');
			shownRaw.items[0].price = 999; // in-place write to a raw array element
			(shownRaw.items as Row[]).push(makeRow(99, () => 0.5)); // in-place push
			flushSync();
			const afterMutation = text('.raw-row');
			shownRaw.assign([...shownRaw.items]); // a new array: Svelte compares the items again
			flushSync();
			const afterNewArray = text('.raw-row');
			shownRaw.replace(0, { ...shownRaw.items[0] }); // a new object for the mutated row
			flushSync();
			const afterNewRowObject = text('.raw-row');
			return { before, afterMutation, afterNewArray, afterNewRowObject };
		},
		/** A `$state` array does not hand back the objects you put in. */
		identity() {
			const src = makeRows(3, 3);
			const deep = new DeepList();
			deep.assign(src);
			const raw = new RawList();
			raw.assign(src);
			deep.items[1].price = 1; // write through the proxy
			return {
				deepSameObject: deep.items[0] === src[0],
				deepIncludes: deep.items.includes(src[0]),
				deepIndexOf: deep.items.indexOf(src[0]),
				deepFindById: deep.items.findIndex((r) => r.id === src[0].id),
				rawSameObject: raw.items[0] === src[0],
				rawIncludes: raw.items.includes(src[0]),
				originalAfterProxyWrite: src[1].price,
				proxyAfterProxyWrite: deep.items[1].price
			};
		},
		/** Hybrid and class rows: an in-place field write updates just that row. */
		fineGrained() {
			shownHybrid.assign(makeRows(3, 5));
			shownClass.assign(makeRows(3, 5));
			shownDeep.assign(makeRows(3, 5));
			flushSync();
			const arraysBefore = [shownHybrid.items, shownClass.items];
			shownHybrid.updatePrice(1, 11); // first edit: promotes row 1 (new array)
			const hybridArrayAfterFirst = shownHybrid.items !== arraysBefore[0];
			const afterFirst = shownHybrid.items;
			shownHybrid.updatePrice(1, 22); // second edit: in place on the proxy
			shownClass.updatePrice(1, 33);
			shownDeep.updatePrice(1, 44);
			flushSync();
			return {
				hybrid: text('.hybrid-row'),
				hybridArrayReplacedOnFirstEdit: hybridArrayAfterFirst,
				hybridArrayKeptOnSecondEdit: shownHybrid.items === afterFirst,
				klass: text('.class-row'),
				classArrayKept: shownClass.items === arraysBefore[1],
				deep: text('.deep-row')
			};
		},
		/**
		 * A big list that nothing renders. Steps are separate so the heap can be sampled
		 * (after a forced GC) from outside between them.
		 */
		quietPrepare(kind: 'deep' | 'raw', n: number) {
			quiet = kind === 'deep' ? new DeepList() : new RawList();
			quietRows = makeRows(n, 1);
		},
		quietAssign() {
			return time(() => {
				quiet.assign(quietRows);
				flushSync();
			}).ms;
		},
		quietRead() {
			return time(() => readAll(quiet.items)).ms;
		},
		quietSnapshot() {
			return time(() => $state.snapshot(quiet.items).length).ms;
		},
		quietStructuredClone() {
			// Only works on plain data: structuredClone throws on a $state proxy.
			try {
				return time(() => structuredClone(quiet.items).length).ms;
			} catch (e) {
				return String(e);
			}
		},
		quietClear() {
			quiet = new RawList();
			quietRows = [];
		}
	};
	(window as any).__gotchas = api;
</script>

<h1>gotchas</h1>
<p>raw: {#each shownRaw.items as r (r.id)}<span class="raw-row">{r.price}</span>{/each}</p>
<p>hybrid: {#each shownHybrid.items as r (r.id)}<span class="hybrid-row">{r.price}</span>{/each}</p>
<p>class: {#each shownClass.items as r (r.id)}<span class="class-row">{r.price}</span>{/each}</p>
<p>deep: {#each shownDeep.items as r (r.id)}<span class="deep-row">{r.price}</span>{/each}</p>
