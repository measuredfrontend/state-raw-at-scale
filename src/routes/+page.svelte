<h1>$state vs $state.raw at scale</h1>
<p>Benchmark pages (browser only; driven by <code>scripts/measure.mjs</code>):</p>
<ul>
	{#each ['deep', 'raw', 'hybrid', 'class', 'map'] as variant}
		<li>
			{variant}:
			<a href="/bench?variant={variant}&mode=data">data</a> ·
			<a href="/bench?variant={variant}&mode=window">window</a> ·
			<a href="/bench?variant={variant}&mode=list">list</a>
		</li>
	{/each}
</ul>
<p>
	Server-rendered list: <a href="/ssr/deep?n=1000">$state</a> ·
	<a href="/ssr/raw?n=1000">$state.raw</a> · <a href="/gotchas">gotchas</a>
</p>
<p>In the browser console, e.g. on /bench: <code>__bench.prepare(10000); await __bench.op('assign')</code></p>
