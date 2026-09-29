// Five ways to hold a big list in Svelte 5. Same operations, different reactivity.
import { SvelteMap } from 'svelte/reactivity';
import { byPriceDesc, type Row } from './rows';

export type Variant = 'deep' | 'raw' | 'hybrid' | 'class' | 'map';
export const VARIANTS: Variant[] = ['deep', 'raw', 'hybrid', 'class', 'map'];

/** What the benchmark page and the tests call. `items` is read by the template. */
export interface ListStore {
	readonly items: readonly Row[];
	assign(rows: Row[]): void;
	updatePrice(i: number, price: number): void;
	replace(i: number, row: Row): void;
	append(row: Row): void;
	sortByPrice(): void;
}

/** Sum two fields of every row, one of them nested: a typical "read all". */
export function readAll(items: readonly Row[]) {
	let sum = 0;
	for (let i = 0; i < items.length; i++) sum += items[i].price + items[i].owner.id;
	return sum;
}

/** 1. `$state`: a deep proxy. Mutate in place. */
export class DeepList implements ListStore {
	items = $state<Row[]>([]);
	assign(rows: Row[]) {
		this.items = rows;
	}
	updatePrice(i: number, price: number) {
		this.items[i].price = price;
	}
	replace(i: number, row: Row) {
		this.items[i] = row;
	}
	append(row: Row) {
		this.items.push(row);
	}
	sortByPrice() {
		this.items.sort(byPriceDesc);
	}
}

/** 2. `$state.raw`: no proxy. Every change is a new array (immutable update). */
export class RawList implements ListStore {
	items = $state.raw<Row[]>([]);
	assign(rows: Row[]) {
		this.items = rows;
	}
	updatePrice(i: number, price: number) {
		this.items = this.items.with(i, { ...this.items[i], price });
	}
	replace(i: number, row: Row) {
		this.items = this.items.with(i, row);
	}
	append(row: Row) {
		this.items = [...this.items, row];
	}
	sortByPrice() {
		this.items = this.items.toSorted(byPriceDesc);
	}
}

/** Make one row deeply reactive. The returned proxy wraps the row; edits go to the proxy. */
export function editable<T extends object>(row: T): T {
	const proxied = $state(row);
	return proxied;
}

/**
 * 3. Hybrid: `$state.raw` for the list, and a `$state` proxy only for rows that get edited.
 * The first edit of a row swaps the proxy into the array (one array copy). After that,
 * edits to that row are fine-grained: no array copy, only that row's cells update.
 */
export class HybridList extends RawList {
	#editable = new Set<number>();
	updatePrice(i: number, price: number) {
		let row = this.items[i];
		if (!this.#editable.has(row.id)) {
			row = editable(row);
			this.#editable.add(row.id);
			this.items = this.items.with(i, row);
		}
		row.price = price;
	}
	assign(rows: Row[]) {
		this.#editable.clear();
		super.assign(rows);
	}
}

/** A row as a class: `$state` fields for what can change, plain fields for the rest. */
export class RowState implements Row {
	id: number;
	name: string;
	email: string;
	updatedAt: string;
	tags: string[];
	owner: Row['owner'];
	status = $state<Row['status']>('open');
	price = $state(0);
	qty = $state(0);
	constructor(r: Row) {
		this.id = r.id;
		this.name = r.name;
		this.email = r.email;
		this.updatedAt = r.updatedAt;
		this.tags = r.tags;
		this.owner = r.owner;
		this.status = r.status;
		this.price = r.price;
		this.qty = r.qty;
	}
}

/** 4. `$state.raw` array of class instances with `$state` fields. Conversion is part of assign. */
export class ClassList implements ListStore {
	items = $state.raw<RowState[]>([]);
	assign(rows: Row[]) {
		this.items = rows.map((r) => new RowState(r));
	}
	updatePrice(i: number, price: number) {
		this.items[i].price = price;
	}
	replace(i: number, row: Row) {
		this.items = this.items.with(i, new RowState(row));
	}
	append(row: Row) {
		this.items = [...this.items, new RowState(row)];
	}
	sortByPrice() {
		this.items = this.items.toSorted(byPriceDesc);
	}
}

/** 5. `SvelteMap` keyed by id. Per-key reactivity; a list view needs `[...values()]`. No order to sort. */
export class MapList implements ListStore {
	map = $state.raw(new SvelteMap<number, Row>());
	items = $derived([...this.map.values()]);
	assign(rows: Row[]) {
		this.map = new SvelteMap(rows.map((r) => [r.id, r]));
	}
	updatePrice(i: number, price: number) {
		const row = this.items[i];
		this.map.set(row.id, { ...row, price });
	}
	replace(i: number, row: Row) {
		this.map.set(this.items[i].id, row);
	}
	append(row: Row) {
		this.map.set(row.id, row);
	}
	sortByPrice() {
		throw new Error('not applicable: a Map keeps insertion order');
	}
}

export function createList(variant: Variant): ListStore {
	switch (variant) {
		case 'deep':
			return new DeepList();
		case 'raw':
			return new RawList();
		case 'hybrid':
			return new HybridList();
		case 'class':
			return new ClassList();
		case 'map':
			return new MapList();
	}
}
