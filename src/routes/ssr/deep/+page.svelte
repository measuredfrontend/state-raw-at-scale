<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { makeRows } from '$lib/rows';
	import RowView from '$lib/RowView.svelte';

	// Server-rendered list held in `$state`. Same seeded rows on server and client.
	const n = Number(page.url.searchParams.get('n') ?? 1000);
	const items = $state(makeRows(n, 1));

	onMount(() => ((window as any).__hydratedAt = performance.now()));
</script>

<p id="stats">deep · rows {items.length}</p>
<table id="list">
	<tbody>
		{#each items as row (row.id)}
			<RowView {row} />
		{/each}
	</tbody>
</table>
