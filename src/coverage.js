import { reactive, watch } from '../lib/vue.esm-browser.prod.js';
import { EARTH_RADIUS, FADE_MARGIN_DB, LORA_SNR_LIMIT, RECEIVER, getSensitivity, toWorldPixels } from './coverage-model.js';

// Crude repeater coverage: the model (coverage-model.js) runs in a worker, so the map stays responsive
export { FADE_MARGIN_DB, RECEIVER, getSensitivity };

export const COVERAGE_OPTIONS = {
	frequency: [{ value: 433, label: '433 MHz' }, { value: 868, label: '868/915 MHz' }],
	txPower: [22, 30],
	antennaGain: [2, 5, 8],
	antennaHeight: [5, 10, 20, 30],
	distanceKm: [40, 120, 250],
	// loss of antennas among buildings and trees (ITU-R P.2108)
	clutter: [
		{ value: true, label: 'On', title: 'Receivers in built-up areas and forests lose 18-22 dB' },
		{ value: false, label: 'Off', title: 'Bare terrain and trees only: the most optimistic' },
	],
	// share of the extra loss of rounded hills (ITU-R P.526) added to the knife edges
	ridgeRounding: [
		{ value: 0, label: 'Off', title: 'Ridges are knife edges: the most optimistic' },
		{ value: 0.25, label: '25 %', title: 'A quarter of the rounded hill loss' },
		{ value: 0.5, label: '50 %', title: 'Half of the rounded hill loss' },
		{ value: 1, label: 'Full', title: 'Ridges are rounded hills (ITU-R P.526): the most pessimistic' },
	],
	nodeDisplay: [{ value: 'reachable', label: 'Reachable only' }, { value: 'all', label: 'All nodes' }],
};
const DEFAULT_SETTINGS = {
	frequency: 868,
	txPower: 22,
	antennaGain: 2,
	antennaHeight: 10,
	distanceKm: 40,
	ridgeRounding: 0.25,
	clutter: true,
	nodeDisplay: 'reachable',
};
const SETTINGS_STORAGE_KEY = 'coverageSettings';
const RADIO_PRESET_STORAGE_KEY = 'coverageRadioPreset';

function loadRadioPreset() {
	try { return localStorage.getItem(RADIO_PRESET_STORAGE_KEY) ?? ''; } catch { return ''; }
}

// MeshCore's default radio settings, for nodes without radio params
const DEFAULT_RADIO = { freq: 869.618, bw: 62.5, sf: 8 };

// Link quality of reachable nodes: margin (dB, on top of the fade margin) needed for 3 / 2 / 1 bars
const LINK_BAR_MARGINS = [20, 10, 0];

export function getLinkBars(margin) {
	const index = LINK_BAR_MARGINS.findIndex(min => margin >= min);
	return index === -1 ? 0 : LINK_BAR_MARGINS.length - index;
}

// Same radio settings as the estimate (otherwise the nodes can't hear each other at all)
export function hasSameRadio(node, radio) {
	const params = node.params ?? {};
	return Math.abs(Number(params.freq) - radio.freq) < 0.01 &&
		Number(params.bw) === radio.bw &&
		Number(params.sf) === radio.sf;
}

function loadSettings() {
	try {
		const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
		// keep only known keys with allowed values
		return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => {
			const allowed = COVERAGE_OPTIONS[key].map(option => option.value ?? option);
			return [key, allowed.includes(stored[key]) ? stored[key] : value];
		}));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

// The coverage settings in a URL: their values in this order, comma separated
const SHARED_SETTINGS = ['frequency', 'txPower', 'antennaGain', 'antennaHeight', 'distanceKm', 'clutter', 'ridgeRounding', 'nodeDisplay'];
const SHARED_VALUES = {
	clutter: [[true, '1'], [false, '0']],
	nodeDisplay: [['reachable', 'r'], ['all', 'a']],
};

export function encodeCoverageSettings(settings) {
	return SHARED_SETTINGS.map(key => {
		const value = settings[key];
		return SHARED_VALUES[key]?.find(([v]) => v === value)?.[1] ?? String(value);
	}).join(',');
}

// Applies the settings from a URL value; values that aren't allowed are left out
export function applyCoverageSettings(text) {
	const parts = String(text).split(',');
	SHARED_SETTINGS.forEach((key, i) => {
		if(parts[i] === undefined || parts[i] === '') return;
		const mapped = SHARED_VALUES[key]?.find(([, code]) => code === parts[i]);
		const value = mapped ? mapped[0] : Number(parts[i]);
		const allowed = COVERAGE_OPTIONS[key].map(option => option.value ?? option);
		if(allowed.includes(value)) coverage.settings[key] = value;
	});
}

// What the coverage panel shows; `publicKey` set = coverage requested for that node, `point`
// ({ lat, lon }) = for a picked point on the map
export const coverage = reactive({
	publicKey: null,
	point: null,
	name: '',
	settings: loadSettings(),
	// radio preset (name) for picked points, '' for the settings of the repeaters around them
	radioPreset: loadRadioPreset(),
	// radio values the estimate was computed with (frequency, bandwidth, spreading factor)
	radio: null,
	// reachable nodes with the same radio settings, per number of bars: { 1: n, 2: n, 3: n }
	linkCounts: null,
	loading: false,
	error: '',
});

watch(() => ({ ...coverage.settings }), settings => {
	try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch {}
});
watch(() => coverage.radioPreset, preset => {
	try { localStorage.setItem(RADIO_PRESET_STORAGE_KEY, preset); } catch {}
});

export function requestCoverage(publicKey) {
	coverage.publicKey = publicKey;
	coverage.point = null;
	coverage.error = '';
}

export function requestPointCoverage(lat, lon) {
	coverage.publicKey = null;
	coverage.point = { lat, lon };
	coverage.error = '';
}

export function closeCoverage() {
	coverage.publicKey = null;
	coverage.point = null;
	coverage.linkCounts = null;
	coverage.loading = false;
	coverage.error = '';
}

// Radio values for the estimate: the band from the settings, the exact frequency, bandwidth and
// spreading factor from the node's radio params when they fit
export function getCoverageRadio(node, settings) {
	const params = node.params ?? {};
	const nodeFreq = Number(params.freq);
	const inBand = settings.frequency === 433
		? nodeFreq >= 410 && nodeFreq <= 525
		: nodeFreq >= 850 && nodeFreq <= 930;
	const sf = Number(params.sf);
	const bw = Number(params.bw);
	return {
		freq: inBand ? nodeFreq : (settings.frequency === 433 ? 433.175 : DEFAULT_RADIO.freq),
		bw: bw > 0 ? bw : DEFAULT_RADIO.bw,
		sf: LORA_SNR_LIMIT[sf] !== undefined ? sf : DEFAULT_RADIO.sf,
	};
}

// repeaters within this distance decide the radio settings of a picked point
const LOCAL_RADIO_RADIUS_KM = 50;

// Radio params for a picked point: the most common ones among the repeaters around it (in the band
// of the settings), so its estimate matches the local network. Null when there are none.
export function getLocalRadioParams(lat, lon, nodes, settings) {
	const counts = new Map();
	const cosLat = Math.cos(lat * Math.PI / 180);
	for(const node of nodes) {
		if(node.type !== 2 || !node.params) continue;
		const distanceKm = Math.hypot((node.lon - lon) * cosLat, node.lat - lat) * 111.2;
		if(distanceKm > LOCAL_RADIO_RADIUS_KM) continue;
		const radio = getCoverageRadio(node, settings);
		if(!hasSameRadio(node, radio)) continue;
		const key = `${radio.freq}|${radio.bw}|${radio.sf}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let best = null, bestCount = 0;
	for(const [key, count] of counts) {
		if(count > bestCount) { best = key; bestCount = count; }
	}
	if(!best) return null;
	const [freq, bw, sf] = best.split('|').map(Number);
	return { freq, bw, sf };
}

// Bounds ([west, south], [east, north]) of the estimate's circle around a point
export function getCoverageBounds(lon, lat, distanceKm) {
	const latDelta = distanceKm * 1000 / EARTH_RADIUS * 180 / Math.PI;
	const lonDelta = latDelta / Math.cos(lat * Math.PI / 180);
	return [[lon - lonDelta, Math.max(-85, lat - latDelta)], [lon + lonDelta, Math.min(85, lat + latDelta)]];
}

let worker = null;
let workerFailed = false;
let nextJob = 0;
const jobs = new Map();

function runInWorker(kind, job) {
	if(!worker) {
		worker = new Worker(new URL('./coverage-worker.js', import.meta.url), { type: 'module' });
		worker.onmessage = ({ data: { id, result, error } }) => {
			const pending = jobs.get(id);
			jobs.delete(id);
			if(error) pending?.reject(new Error(error));
			else pending?.resolve(result);
		};
		// the worker couldn't start (e.g. no module workers): compute on the main thread instead
		worker.onerror = event => {
			event.preventDefault();
			console.warn('Coverage worker failed, computing on the main thread', event.message);
			workerFailed = true;
			worker = null;
			for(const [id, pending] of jobs) {
				jobs.delete(id);
				runHere(pending.kind, pending.job).then(pending.resolve, pending.reject);
			}
		};
	}
	return new Promise((resolve, reject) => {
		const id = ++nextJob;
		jobs.set(id, { kind, job, resolve, reject });
		worker.postMessage({ id, kind, job });
	});
}

async function runHere(kind, job) {
	const model = await import('./coverage-model.js');
	return kind === 'profile' ? model.computeProfile(job) : model.computeCoverageGrid(job);
}

function run(kind, job) {
	return workerFailed ? runHere(kind, job) : runInWorker(kind, job);
}

// Terrain profile and link budget between two antennas ({ lat, lon, height }) with the coverage
// settings (TX power and antenna gain on both ends) and the given radio values (see computeProfile)
export function computeLinkProfile(a, b, settings, radio) {
	return run('profile', {
		a: { ...a, gain: settings.antennaGain },
		b: { ...b, gain: settings.antennaGain },
		settings: { ...settings },
		radio,
		rounding: settings.ridgeRounding,
	});
}

// Estimates the coverage of a node (in a worker). Returns an image source for the map
// ({ url, coordinates }; the url is a blob URL, release it with releaseCoverage), the link margin at
// any location (marginAt) and some stats.
export async function computeCoverage(node, settings) {
	const radio = getCoverageRadio(node, settings);
	const job = { lat: node.lat, lon: node.lon, settings: { ...settings }, radio, rounding: settings.ridgeRounding };
	const { grid, blob, coordinates, incomplete, stats } = await run('coverage', job);
	const { margins, clutter, clutterLosses, left, top, size, worldSize, cx, cy, radius } = grid;

	// link margin at a location (dB), null outside the estimate's circle; with `clutter`, for an
	// antenna among the buildings and trees there (a handheld), otherwise above them (on a roof or mast)
	function marginAt(lonAt, latAt, { clutter: withClutter = true } = {}) {
		const [wx, wy] = toWorldPixels(lonAt, latAt, worldSize);
		const sx = Math.floor(wx) - left, sy = Math.floor(wy) - top;
		if(Math.hypot(sx - cx, sy - cy) > radius) return null;
		// a pixel the rays skipped: the best of its neighbours
		let best = -Infinity;
		for(let y = Math.max(0, sy - 1); y <= Math.min(size - 1, sy + 1); y++) {
			for(let x = Math.max(0, sx - 1); x <= Math.min(size - 1, sx + 1); x++) {
				const index = y * size + x;
				const margin = withClutter ? margins[index] - clutterLosses[clutter[index]] : margins[index];
				if(x === sx && y === sy && margin > -Infinity) return margin;
				best = Math.max(best, margin);
			}
		}
		return best;
	}

	return { marginAt, url: URL.createObjectURL(blob), coordinates, radio, incomplete, stats };
}

// Frees the image of an estimate that isn't shown anymore
export function releaseCoverage(result) {
	if(result?.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
}
