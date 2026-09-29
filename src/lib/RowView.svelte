<script lang="ts">
	import type { Row } from './rows';
	let { row }: { row: Row } = $props();
</script>

<tr data-id={row.id}>
	<td>{row.id}</td>
	<td>{row.name}</td>
	<td>{row.status}</td>
	<td>{row.price.toFixed(2)}</td>
	<td>{row.qty}</td>
	<td>{row.owner.name}</td>
	<td>{row.owner.team}</td>
</tr>
