import { PRESETS_API_URL } from './config.js';

let presets = [];
let loading = null;

export function presetsLoaded() {
	return presets.length > 0;
}

// Fetches presets once; concurrent callers share the same request, a failed one is retried next time
export function loadPresets() {
	loading ??= fetchPresets().catch(e => {
		loading = null;
		throw e;
	});
	return loading;
}

async function fetchPresets() {
	const res = await fetch(PRESETS_API_URL);
	const entries = (await res.json()).config.suggested_radio_settings.entries;

	presets = [
		{ name: 'All presets', params: {} },
		...entries.map(p => ({
			name: p.title,
			desc: p.description,
			params: {
				freq: p.frequency,
				bw: p.bandwidth,
				sf: p.spreading_factor,
				cr: p.coding_rate,
			},
		})),
	];

	return presets;
}

// Returns all known presets whose radio params match `params` (empty until loadPresets() resolves)
export function findPresets(params) {
	return presets.filter(p =>
		Object.keys(p.params).length > 0 &&
		params.sf == p.params.sf &&
		params.freq == p.params.freq &&
		params.bw == p.params.bw &&
		params.cr == p.params.cr
	);
}

// The community presets (without the "All presets" filter entry), with numeric radio params
export function getRadioPresets() {
	return presets
		.filter(p => Object.keys(p.params).length > 0)
		.map(p => ({ name: p.name, desc: p.desc, params: p.params, radio: { freq: Number(p.params.freq), bw: Number(p.params.bw), sf: Number(p.params.sf) } }));
}
