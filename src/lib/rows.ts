// Realistic row objects: 9 fields, one nested object and one small array.
// Deterministic (seeded), so every variant and every run gets the same data.

export type Status = 'open' | 'paid' | 'late' | 'void';

export type Row = {
	id: number;
	name: string;
	email: string;
	status: Status;
	price: number;
	qty: number;
	updatedAt: string;
	tags: string[];
	owner: { id: number; name: string; team: string };
};

const STATUSES: Status[] = ['open', 'paid', 'late', 'void'];
const TEAMS = ['north', 'south', 'east', 'west', 'core'];

/** Small seeded PRNG (mulberry32). */
function rng(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function makeRow(id: number, random: () => number = Math.random): Row {
	const owner = Math.floor(random() * 500);
	return {
		id,
		name: `Invoice ${id}`,
		email: `customer${id % 9973}@example.com`,
		status: STATUSES[Math.floor(random() * 4)],
		price: Math.round(random() * 100_000) / 100,
		qty: 1 + Math.floor(random() * 20),
		updatedAt: new Date(1_767_225_600_000 + id * 60_000).toISOString(),
		tags: id % 3 === 0 ? ['priority', 'eu'] : ['eu'],
		owner: { id: owner, name: `Owner ${owner}`, team: TEAMS[owner % 5] }
	};
}

export function makeRows(n: number, seed = 1): Row[] {
	const random = rng(seed);
	const rows = new Array<Row>(n);
	for (let i = 0; i < n; i++) rows[i] = makeRow(i, random);
	return rows;
}

export const byPriceDesc = (a: { price: number }, b: { price: number }) => b.price - a.price;
