import { reactive, watch } from '../lib/vue.esm-browser.prod.js';
import { ANTENNA_TYPES, BUILDINGS_MAX_DISTANCE, EARTH_RADIUS, FADE_MARGIN_DB, LORA_SNR_LIMIT, RECEIVER, getSensitivity, toWorldPixels } from './coverage-model.js';

// Crude repeater coverage: the model (coverage-model.js) runs in a worker, so the map stays responsive
export { ANTENNA_TYPES, BUILDINGS_MAX_DISTANCE, FADE_MARGIN_DB, RECEIVER, getSensitivity };

export const COVERAGE_OPTIONS = {
	frequency: [{ value: 433, label: '433 MHz' }, { value: 868, label: '868/915 MHz' }],
	antennaType: [
		{ value: 'omni', label: 'Omni', title: 'The same in every direction' },
		{ value: 'yagi', label: 'Yagi', title: 'Directional, with a back lobe (about 15 dB below the front)' },
		{ value: 'panel', label: 'Panel', title: 'Directional patch / micro-strip antenna, little signal behind it' },
	],
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
// settings set with sliders: their range and step
export const COVERAGE_SLIDERS = {
	txPower: { min: 0, max: 40, step: 1, unit: 'dBm' },
	antennaGain: { min: 0, max: 20, step: 0.5, unit: 'dBi' },
	antennaHeight: { min: 0, max: 300, step: 1, unit: 'm' },
	// half-power beam width of directional antennas
	beamWidth: { min: 10, max: 180, step: 5, unit: '°' },
	// where they point (bearing)
	direction: { min: 0, max: 359, step: 1, unit: '°' },
};

function isAllowed(key, value) {
	const slider = COVERAGE_SLIDERS[key];
	if(slider) {
		return typeof value === 'number' && value >= slider.min && value <= slider.max &&
			Math.abs(Math.round((value - slider.min) / slider.step) * slider.step - (value - slider.min)) < 1e-9;
	}
	return COVERAGE_OPTIONS[key].some(option => (option.value ?? option) === value);
}

const DEFAULT_SETTINGS = {
	frequency: 868,
	txPower: 22,
	antennaGain: 2,
	antennaHeight: 10,
	antennaType: 'omni',
	beamWidth: 60,
	direction: 0,
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
		return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, isAllowed(key, stored[key]) ? stored[key] : value]));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

// The coverage settings in a URL: their values in this order, comma separated
// (new ones go at the end, so older links still work)
const SHARED_SETTINGS = [
	'frequency', 'txPower', 'antennaGain', 'antennaHeight', 'distanceKm', 'clutter', 'ridgeRounding', 'nodeDisplay',
	'antennaType', 'beamWidth', 'direction',
];
const SHARED_VALUES = {
	clutter: [[true, '1'], [false, '0']],
	nodeDisplay: [['reachable', 'r'], ['all', 'a']],
	antennaType: [['omni', 'o'], ['yagi', 'y'], ['panel', 'p']],
};

export function encodeCoverageSettings(settings) {
	return SHARED_SETTINGS.map(key => {
		const value = settings[key];
		return SHARED_VALUES[key]?.find(([v]) => v === value)?.[1] ?? String(value);
	}).join(',');
}

// Applies the settings from a URL value to the given settings (the selected site's, or the ones new
// sites start with); values that aren't allowed are left out
export function applyCoverageSettings(text, target = coverage.settings) {
	const parts = String(text).split(',');
	SHARED_SETTINGS.forEach((key, i) => {
		if(parts[i] === undefined || parts[i] === '') return;
		const mapped = SHARED_VALUES[key]?.find(([, code]) => code === parts[i]);
		const value = mapped ? mapped[0] : Number(parts[i]);
		if(isAllowed(key, value)) target[key] = value;
	});
}

// Coverage sites: nodes (`publicKey`) or picked points on the map (`point`: { lat, lon }), each with
// settings and a radio preset of its own. The panel shows (and its settings change) the selected one;
// `coverage.settings`, `coverage.point`, ... are the selected site's. Without sites they are the
// settings new sites start with.
export const MAX_COVERAGE_SITES = 6;
let nextSiteId = 1;

const defaults = reactive({ settings: loadSettings(), radioPreset: loadRadioPreset() });

function activeSite() {
	return coverage.sites.find(site => site.id === coverage.activeId) ?? null;
}

export const coverage = reactive({
	// [{ id, publicKey, point, name, settings, radioPreset, radio, linkCounts, loading, error }]
	sites: [],
	activeId: null,
	// sites reached by two or more sites stand out
	highlightOverlaps: false,
	// area (km²) reached by two or more sites, while they're highlighted
	overlapKm2: null,
	get active() { return activeSite(); },
	get publicKey() { return activeSite()?.publicKey ?? null; },
	get point() { return activeSite()?.point ?? null; },
	set point(point) { const site = activeSite(); if(site) site.point = point; },
	get name() { return activeSite()?.name ?? ''; },
	set name(name) { const site = activeSite(); if(site) site.name = name; },
	get settings() { return activeSite()?.settings ?? defaults.settings; },
	// radio preset (name) for picked points, '' for the settings of the repeaters around them
	get radioPreset() { return activeSite()?.radioPreset ?? defaults.radioPreset; },
	set radioPreset(preset) { (activeSite() ?? defaults).radioPreset = preset; },
	// radio values the estimate was computed with (frequency, bandwidth, spreading factor)
	get radio() { return activeSite()?.radio ?? null; },
	// reachable nodes with the same radio settings, per number of bars: { 1: n, 2: n, 3: n }
	get linkCounts() { return activeSite()?.linkCounts ?? null; },
	get loading() { return activeSite()?.loading ?? false; },
	get error() { return activeSite()?.error ?? ''; },
	set error(error) { const site = activeSite(); if(site) site.error = error; },
});

// the selected site's settings are the ones new sites start with (and are kept for the next visit)
watch(() => ({ ...coverage.settings }), settings => {
	Object.assign(defaults.settings, settings);
	try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch {}
});
watch(() => coverage.radioPreset, preset => {
	defaults.radioPreset = preset;
	try { localStorage.setItem(RADIO_PRESET_STORAGE_KEY, preset); } catch {}
});
// which nodes show is a display setting: the same for all sites
watch(() => coverage.settings.nodeDisplay, display => {
	for(const site of coverage.sites) site.settings.nodeDisplay = display;
});

// Adds a site (selected, with the selected site's settings, or the given ones). With MAX_COVERAGE_SITES
// already there, the selected one is replaced.
export function addCoverageSite({ publicKey = null, point = null }, { settings = null, radioPreset = null } = {}) {
	const site = {
		id: nextSiteId++,
		publicKey,
		point,
		name: '',
		settings: { ...(settings ?? coverage.settings) },
		radioPreset: radioPreset ?? coverage.radioPreset,
		radio: null,
		linkCounts: null,
		loading: false,
		error: '',
	};
	if(coverage.sites.length >= MAX_COVERAGE_SITES) {
		const index = Math.max(0, coverage.sites.findIndex(s => s.id === coverage.activeId));
		coverage.sites.splice(index, 1, site);
	} else {
		coverage.sites.push(site);
	}
	coverage.activeId = site.id;
	return coverage.sites.find(s => s.id === site.id);
}

// Coverage of a node: selects its site when there's one already, else adds one
export function requestCoverage(publicKey) {
	const site = coverage.sites.find(s => s.publicKey === publicKey);
	if(site) coverage.activeId = site.id;
	else addCoverageSite({ publicKey });
}

export function requestPointCoverage(lat, lon) {
	addCoverageSite({ point: { lat, lon } });
}

export function selectCoverageSite(id) {
	if(coverage.sites.some(site => site.id === id)) coverage.activeId = id;
}

// Removes the selected site (or the given one); the one before it gets selected
export function closeCoverage(id = coverage.activeId) {
	const index = coverage.sites.findIndex(site => site.id === id);
	if(index < 0) return;
	coverage.sites.splice(index, 1);
	if(coverage.activeId === id) coverage.activeId = coverage.sites[Math.max(0, index - 1)]?.id ?? null;
}

export function closeAllCoverage() {
	coverage.sites.splice(0);
	coverage.activeId = null;
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
		// both antennas are taken to be aimed at each other (a directional one only adds its gain)
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
	const { grid, shadow, blob, coordinates, incomplete, stats } = await run('coverage', job);
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

	// lines on the map: the estimate's edge and where a directional antenna points
	const lines = {
		center: [node.lon, node.lat],
		radius: settings.distanceKm * 1000,
		bearing: ANTENNA_TYPES[settings.antennaType] ? settings.direction : null,
	};
	// shadow: how high above the ground the line of sight passes, for the 3D view
	return { marginAt, url: URL.createObjectURL(blob), coordinates, lines, shadow, radio, incomplete, stats };
}

// Frees the image of an estimate that isn't shown anymore
export function releaseCoverage(result) {
	if(result?.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
}

// where two or more sites reach: blue, stronger where more of them do
const OVERLAP_RGB = [37, 99, 235];
const OVERLAP_ALPHA = { 2: 0.6, 3: 0.8 };
// the overlap image's longer side (pixels)
const OVERLAP_MAX_SIZE = 1024;

const mercatorY = lat => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
const latitudeOf = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

// Where two or more estimates (from computeCoverage) reach a handheld (link margin 0 dB or more):
// { url (a blob URL, release it with releaseCoverage), coordinates, areaKm2 }, null without overlaps
export async function computeOverlap(results) {
	// each estimate's square: [west, south, east, north]
	const boxes = results.map(({ coordinates: [[west, north], [east], [, south]] }) => [west, south, east, north]);
	// only where at least two squares overlap
	let area = null;
	for(let i = 0; i < boxes.length; i++) {
		for(let j = i + 1; j < boxes.length; j++) {
			const [w1, s1, e1, n1] = boxes[i], [w2, s2, e2, n2] = boxes[j];
			const box = [Math.max(w1, w2), Math.max(s1, s2), Math.min(e1, e2), Math.min(n1, n2)];
			if(box[0] >= box[2] || box[1] >= box[3]) continue;
			area = area ? [Math.min(area[0], box[0]), Math.min(area[1], box[1]), Math.max(area[2], box[2]), Math.max(area[3], box[3])] : box;
		}
	}
	if(!area) return null;

	const [west, south, east, north] = area;
	const x0 = (west + 180) / 360, x1 = (east + 180) / 360;
	const y0 = mercatorY(north), y1 = mercatorY(south);
	const scale = OVERLAP_MAX_SIZE / Math.max(x1 - x0, y1 - y0);
	const width = Math.max(1, Math.round((x1 - x0) * scale)), height = Math.max(1, Math.round((y1 - y0) * scale));
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	const image = ctx.createImageData(width, height);
	const pixels = image.data;
	let areaM2 = 0;
	for(let py = 0; py < height; py++) {
		const lat = latitudeOf(y0 + (py + 0.5) / height * (y1 - y0));
		const metersPerPixel = 2 * Math.PI * EARTH_RADIUS * Math.cos(lat * Math.PI / 180) * (x1 - x0) / width;
		// the estimates this row crosses
		const inRow = results.filter((_, i) => lat >= boxes[i][1] && lat <= boxes[i][3]);
		if(inRow.length < 2) continue;
		for(let px = 0; px < width; px++) {
			const lon = west + (px + 0.5) / width * (east - west);
			let count = 0;
			for(const result of inRow) {
				const margin = result.marginAt(lon, lat);
				if(margin !== null && margin >= 0) count++;
			}
			if(count < 2) continue;
			const i = (py * width + px) * 4;
			pixels[i] = OVERLAP_RGB[0];
			pixels[i + 1] = OVERLAP_RGB[1];
			pixels[i + 2] = OVERLAP_RGB[2];
			pixels[i + 3] = Math.round(255 * OVERLAP_ALPHA[Math.min(3, count)]);
			areaM2 += metersPerPixel * metersPerPixel;
		}
	}
	if(areaM2 === 0) return null;
	ctx.putImageData(image, 0, 0);
	const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
	return {
		url: URL.createObjectURL(blob),
		coordinates: [[west, north], [east, north], [east, south], [west, south]],
		areaKm2: areaM2 / 1e6,
	};
}
