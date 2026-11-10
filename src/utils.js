export const MS_PER_DAY = 24 * 60 * 60 * 1000;

const byteToHex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function bytesToHex(bytes) {
	let hex = '';
	for(let i = 0; i < bytes.length; i++) {
		hex += byteToHex[bytes[i]];
	}
	return hex;
}

export function escapeHtml(str) {
	return String(str).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

export function daysAgo(days, now = Date.now()) {
	return now - days * MS_PER_DAY;
}

const TIME_UNITS = [
	{ name: 'year', seconds: 31536000 },
	{ name: 'month', seconds: 2592000 },
	{ name: 'day', seconds: 86400 },
	{ name: 'hour', seconds: 3600 },
	{ name: 'minute', seconds: 60 },
	{ name: 'second', seconds: 1 },
];

export function timeAgo(msec) {
	const seconds = Math.floor((Date.now() - msec) / 1000);

	for(const unit of TIME_UNITS) {
		const count = Math.floor(seconds / unit.seconds);
		if(count >= 1) {
			return `${count} ${unit.name}${count > 1 ? 's' : ''} ago`;
		}
	}

	return 'just now';
}

// Returns escaped HTML of `source` with the first case-insensitive match of `needle` wrapped in <b>
export function highlightMatch(source, needle) {
	const index = needle ? source.toLowerCase().indexOf(needle.toLowerCase()) : -1;
	if(index < 0) return escapeHtml(source);

	const end = index + needle.length;
	return escapeHtml(source.slice(0, index)) +
		`<b>${escapeHtml(source.slice(index, end))}</b>` +
		escapeHtml(source.slice(end));
}

// Runs `fn` for every item, yielding to the browser between chunks so the UI stays responsive
export async function forEachChunked(items, chunkSize, fn) {
	for(let offset = 0; offset < items.length; offset += chunkSize) {
		if(offset > 0) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		const end = Math.min(offset + chunkSize, items.length);
		for(let i = offset; i < end; i++) {
			fn(items[i], i);
		}
	}
}

// CSS filter functions (saturate, hue-rotate, grayscale, contrast) applied to pixels, as the Filter
// Effects spec defines them: 3x4 colour matrices in sRGB, clamped after each function. Safari doesn't
// support the canvas `filter` property, so canvas images are filtered with this instead.
function luminanceMatrix([r, g, b], s) {
	return [
		r + (1 - r) * s, g - g * s, b - b * s, 0,
		r - r * s, g + (1 - g) * s, b - b * s, 0,
		r - r * s, g - g * s, b + (1 - b) * s, 0,
	];
}

const FILTER_MATRICES = {
	saturate: s => luminanceMatrix([0.213, 0.715, 0.072], s),
	grayscale: a => luminanceMatrix([0.2126, 0.7152, 0.0722], 1 - Math.min(1, a)),
	'hue-rotate': degrees => {
		const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
		return [
			0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928, 0,
			0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283, 0,
			0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072, 0,
		];
	},
	contrast: c => [c, 0, 0, 0.5 - 0.5 * c, 0, c, 0, 0.5 - 0.5 * c, 0, 0, c, 0.5 - 0.5 * c],
};

function parseCssFilter(filter) {
	return [...filter.matchAll(/([a-z-]+)\(\s*([\d.]+)\s*(deg|%)?\s*\)/g)].map(([, name, value, unit]) => {
		const matrix = FILTER_MATRICES[name];
		if(!matrix) throw new Error(`Unsupported filter: ${name}`);
		return matrix(unit === '%' ? value / 100 : Number(value));
	});
}

// Filters the pixels of `imageData` in place; `alpha` scales their opacity afterwards
export function applyCssFilter(imageData, filter, alpha = 1) {
	const matrices = parseCssFilter(filter);
	const data = imageData.data;
	for(let i = 0; i < data.length; i += 4) {
		if(data[i + 3] === 0) continue;
		let r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
		for(const m of matrices) {
			const nr = m[0] * r + m[1] * g + m[2] * b + m[3];
			const ng = m[4] * r + m[5] * g + m[6] * b + m[7];
			const nb = m[8] * r + m[9] * g + m[10] * b + m[11];
			r = Math.min(1, Math.max(0, nr));
			g = Math.min(1, Math.max(0, ng));
			b = Math.min(1, Math.max(0, nb));
		}
		data[i] = Math.round(r * 255);
		data[i + 1] = Math.round(g * 255);
		data[i + 2] = Math.round(b * 255);
		data[i + 3] = Math.round(data[i + 3] * alpha);
	}
	return imageData;
}
