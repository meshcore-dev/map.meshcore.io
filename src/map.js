import { LngLatBounds, Map as MapLibreMap, MercatorCoordinate, Popup } from '../lib/maplibre-gl.mjs';
import { DEFAULT_FILTERS } from './config.js';
import { getColourForName, getNameIconLabel } from './node-utils.js';
import { applyCssFilter } from './utils.js';
import { getNodePopupHTML } from './popup.js';
import { THEME_MODES, cycleThemeMode, getThemeMode, isDarkTheme, onThemeChange } from './theme.js';

const APP_ATTRIBUTION = `
	App: recrof, <a target="_blank" href="https://github.com/sponsors/recrof?frequency=one-time&sponsor=recrof">
	<strong>support my work</strong></a> |
	<a href="#deletion-request"><strong>Node deletion request</strong></a>
`;
// (MapLibre sanitizes attribution HTML and drops data-* attributes, so the link is recognised by its href)

// Base map styles; the vector map follows the app's light/dark theme
const BASE_MAPS = {
	// OpenStreetMap data as vector tiles (OpenFreeMap)
	'OSM Vector': () => `https://tiles.openfreemap.org/styles/${isDarkTheme() ? 'dark' : 'liberty'}`,
	// OpenStreetMap data as vector tiles (VersaTiles), more detailed dark theme
	'VersaTiles': () => `https://tiles.versatiles.org/assets/styles/${isDarkTheme() ? 'colorful-dark' : 'colorful'}/style.json`,
	'Satellite': () => ({
		version: 8,
		sources: {
			satellite: {
				type: 'raster',
				tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
				tileSize: 256,
				// highest tile zoom provided, the map overzooms past it
				maxzoom: 18,
				attribution: 'Tiles: &copy; Esri | Sources: Esri, DigitalGlobe, GeoEye, i-cubed, USDA FSA, USGS, AEX, Getmapping, Aerogrid, IGN, IGP, swisstopo, GIS Users',
			},
		},
		layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
	}),
	// the classic openstreetmap.org map: peaks with their elevation, handy for planning repeater sites
	'OSM Standard': () => ({
		version: 8,
		sources: {
			osm: {
				type: 'raster',
				tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
				tileSize: 256,
				maxzoom: 19,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
			},
		},
		layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
	}),
};
const DEFAULT_BASE_MAP = 'OSM Vector';
// base map names stored by earlier versions of the app
const LEGACY_BASE_MAPS = { 'OpenStreetMap': 'OSM Vector', 'Map': 'OSM Vector', 'Esri Satellite': 'Satellite' };

const ICON_SIZE = 32;
// CSS filters tinting the node type icons by freshness (same as the .status-dot classes in style.css)
const STATUS_ICON_STYLE = {
	recent: { filter: 'saturate(5) hue-rotate(260deg)' },
	stale: { filter: 'saturate(28) hue-rotate(228deg)' },
	old: { filter: 'saturate(5) hue-rotate(165deg)' },
	// the faded grey icon disappears on dark backgrounds (dark map, satellite), the outline keeps it visible
	extinct: { filter: 'grayscale(100) contrast(16)', alpha: 0.6, outline: '#bdbdbd' },
};
// [threshold, outer colour, inner colour] - the classic marker cluster look
const CLUSTER_STYLES = [
	[10, 'rgba(181, 226, 140, 0.6)', 'rgba(110, 204, 57, 0.6)'],
	[100, 'rgba(241, 211, 87, 0.6)', 'rgba(240, 194, 12, 0.6)'],
	[Infinity, 'rgba(253, 156, 115, 0.6)', 'rgba(241, 128, 23, 0.6)'],
];
const CLUSTER_RADIUS = 80;

const HIGHLIGHT_COLOR = '#d32f2f';
// planning: picked points (coverage, profile ends) and the line between the profile ends
const PLANNING_COLOR = '#1e88e5';
const PLANNING_POINT_SIZE = 28;

// Nodes closer than this (in pixels) at the closest zoom would still overlap there - they get spread
// around their shared point. Their spacing is in screen pixels, so they look the same at every zoom.
const SPIDER_OVERLAP_PX = 24;
const SPIDER_FOOT_SEPARATION = 36;
const SPIDER_MIN_RADIUS = 30;
const SPIDER_MAX_CIRCLE_NODES = 8;
const SPIDER_LEG_COLOR = 'rgba(128, 128, 128, 0.9)';
// overlapping groups stay cluster bubbles at least until this (app) zoom, then until their spread is clear
const SPIDER_MIN_REVEAL_APP_ZOOM = 16;
// minimum free space (pixels) between a spread out group and its neighbours
const SPIDER_CLEAR_GAP = 4;
// size of the cluster bubble drawn for a group that isn't spread out yet
const GROUP_BUBBLE_SIZE = 40;

// The app (URL params, config, clustering slider) uses classic 256px-tile zoom levels;
// MapLibre's zoom levels are based on 512px tiles, so they are one lower at the same scale
export const toMapZoom = zoom => zoom - 1;
export const fromMapZoom = zoom => zoom + 1;

// the closest zoom the map allows (app zoom levels)
const MAX_APP_ZOOM = 19;

// MapLibre clusters at tile zoom <= clusterMaxZoom; clustering should stop at the given app zoom
const clusterMaxZoomFor = clusteringZoom => toMapZoom(clusteringZoom) - 1;

function readBaseMapSelection() {
	try {
		const stored = localStorage.getItem('baseMapSelected');
		const selected = LEGACY_BASE_MAPS[stored] ?? stored;
		return BASE_MAPS[selected] ? selected : DEFAULT_BASE_MAP;
	} catch {
		return DEFAULT_BASE_MAP;
	}
}

function emptyCollection() {
	return { type: 'FeatureCollection', features: [] };
}

// layers that only show where nodes aren't clustered (their minzoom follows the clustering zoom)
const UNCLUSTERED_LAYER_IDS = ['groups', 'spread-nodes', 'spider-legs', 'spider-centers', 'node-labels', 'link-quality'];

// A group of overlapping nodes is one point in the node clusters, counting as `count` nodes. Where nodes
// aren't clustered, it shows as a bubble below its `reveal` zoom (bubbles of nearby groups merge, see the
// bubble source), from there on its nodes are spread around the shared point.
const isRevealed = ['>=', ['zoom'], ['get', 'reveal']];

// Layers drawn on top of the base map
// label images per theme (dark text on light maps and vice versa)
const labelImageExpression = theme => ['concat', 'name|', theme, '|', ['get', 'name']];
// names of all nodes show from this (app) zoom on, unless turned off
export const NODE_NAMES_ZOOM = 12;

function createOverlayLayers({ clusterMaxZoom, offsetExpression, labelOffsetExpression, labelTheme, nodeNames }) {
	const unclusteredMinZoom = clusterMaxZoom + 1;
	// node names when zoomed in close: hidden where they would overlap each other
	const nodeNameLayout = offset => ({
		visibility: nodeNames ? 'visible' : 'none',
		'icon-image': labelImageExpression(labelTheme),
		'icon-anchor': 'top',
		'icon-offset': offset,
		'icon-allow-overlap': false,
		'icon-ignore-placement': false,
		// where names would overlap, repeaters' win
		'symbol-sort-key': ['get', 'namePriority'],
	});
	const clusterBubble = {
		'icon-image': ['concat', 'cluster|', ['get', 'count']],
		'icon-allow-overlap': true,
		'icon-ignore-placement': true,
	};
	return [
		// rings around nodes, drawn below the markers so they stay visible while a node is clustered
		{
			id: 'highlight',
			type: 'symbol',
			source: 'highlight',
			layout: {
				'icon-image': 'highlight-ring',
				'icon-offset': offsetExpression,
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
			},
		},
		{
			id: 'clusters',
			type: 'symbol',
			source: 'nodes',
			filter: ['has', 'point_count'],
			layout: clusterBubble,
		},
		// lines from spread out nodes to the point they share
		{
			id: 'spider-legs',
			type: 'symbol',
			source: 'spider',
			minzoom: unclusteredMinZoom,
			filter: ['all', ['has', 'leg'], isRevealed],
			layout: {
				'icon-image': ['get', 'leg'],
				'icon-anchor': 'left',
				'icon-rotate': ['get', 'angle'],
				'icon-rotation-alignment': 'viewport',
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
			},
		},
		{
			id: 'spider-centers',
			type: 'circle',
			source: 'spider',
			minzoom: unclusteredMinZoom,
			filter: ['all', ['!', ['has', 'leg']], isRevealed],
			paint: {
				'circle-radius': 3,
				'circle-color': SPIDER_LEG_COLOR,
			},
		},
		{
			id: 'nodes',
			type: 'symbol',
			source: 'nodes',
			filter: ['all', ['!', ['has', 'point_count']], ['!', ['has', 'group']]],
			layout: {
				'icon-image': ['get', 'icon'],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
			},
		},
		// overlapping groups that aren't revealed yet - above single nodes, so they stay visible and clickable
		{
			id: 'groups',
			type: 'symbol',
			source: 'bubbles',
			minzoom: unclusteredMinZoom,
			filter: ['!', isRevealed],
			layout: clusterBubble,
		},
		{
			id: 'spread-nodes',
			type: 'symbol',
			source: 'spread',
			minzoom: unclusteredMinZoom,
			filter: isRevealed,
			layout: {
				'icon-image': ['get', 'icon'],
				'icon-offset': offsetExpression,
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
			},
		},
		{
			id: 'node-names',
			type: 'symbol',
			source: 'nodes',
			minzoom: toMapZoom(NODE_NAMES_ZOOM),
			filter: ['all', ['!', ['has', 'point_count']], ['!', ['has', 'group']]],
			layout: nodeNameLayout(LABEL_BASE_OFFSET),
		},
		{
			id: 'spread-node-names',
			type: 'symbol',
			source: 'spread',
			minzoom: toMapZoom(NODE_NAMES_ZOOM),
			filter: isRevealed,
			layout: nodeNameLayout(labelOffsetExpression),
		},
		// node names (coverage, reachable nodes only): hidden where they would overlap each other,
		// the repeater's and the best connected nodes' first
		{
			id: 'node-labels',
			type: 'symbol',
			source: 'links',
			minzoom: unclusteredMinZoom,
			filter: ['all', ['==', ['get', 'label'], true], ['any', ['!', ['has', 'reveal']], isRevealed]],
			layout: {
				'icon-image': labelImageExpression(labelTheme),
				'icon-anchor': 'top',
				'icon-offset': labelOffsetExpression,
				// labels block each other (and the base map's labels below)
				'icon-allow-overlap': false,
				'icon-ignore-placement': false,
				'symbol-sort-key': ['get', 'priority'],
			},
		},
		// link quality badges (coverage): only where their node is shown on its own
		{
			id: 'link-quality',
			type: 'symbol',
			source: 'links',
			minzoom: unclusteredMinZoom,
			filter: ['all', ['>', ['get', 'bars'], 0], ['any', ['!', ['has', 'reveal']], isRevealed]],
			layout: {
				'icon-image': ['concat', 'bars|', ['get', 'bars']],
				'icon-offset': offsetExpression,
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
			},
		},
		// planning, on top of everything
		{
			id: 'planning-line',
			type: 'line',
			source: 'planning',
			filter: ['==', ['geometry-type'], 'LineString'],
			layout: { 'line-cap': 'round' },
			paint: { 'line-color': PLANNING_COLOR, 'line-width': 3, 'line-dasharray': [2, 1.5] },
		},
		{
			id: 'planning-hover',
			type: 'circle',
			source: 'planning',
			filter: ['==', ['get', 'kind'], 'hover'],
			paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': PLANNING_COLOR, 'circle-stroke-width': 3 },
		},
		{
			id: 'planning-points',
			type: 'symbol',
			source: 'planning',
			filter: ['==', ['get', 'kind'], 'point'],
			layout: {
				'icon-image': ['concat', 'plan|', ['get', 'label']],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
			},
		},
	];
}

const COVERAGE_LAYER = {
	id: 'coverage',
	type: 'raster',
	source: 'coverage',
	paint: { 'raster-fade-duration': 0 },
};

function coverageSource({ url, coordinates }) {
	return { type: 'image', url, coordinates };
}

// Shows the estimated coverage image ({ url, coordinates } from computeCoverage) below the nodes, null hides it
export function setCoverageOverlay(map, coverage) {
	map.overlays.set({ coverage });
}

// Planning marks: points ([{ lngLat, label }], label '' for a plain point), the line between the
// profile ends ([lngLat, lngLat] or null) and a highlighted spot on it (lngLat or null)
export function setPlanningOverlay(map, { points = [], line = null, hover = null } = {}) {
	const features = [];
	if(line) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { kind: 'line' } });
	for(const { lngLat, label } of points) {
		features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: lngLat }, properties: { kind: 'point', label } });
	}
	if(hover) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: hover }, properties: { kind: 'hover' } });
	map.overlays.set({ planning: { type: 'FeatureCollection', features } });
}

// The point a share `t` (0..1) along the straight map line from a to b ([lon, lat])
export function interpolateMapLine(a, b, t) {
	const ma = MercatorCoordinate.fromLngLat(a), mb = MercatorCoordinate.fromLngLat(b);
	const { lng, lat } = new MercatorCoordinate(ma.x + (mb.x - ma.x) * t, ma.y + (mb.y - ma.y) * t).toLngLat();
	return [lng, lat];
}

// Names of all nodes when zoomed in close (from NODE_NAMES_ZOOM)
export function setNodeNames(map, enabled) {
	map.overlays.set({ nodeNames: enabled });
}

// Link quality badges (1-3 bars) next to the given nodes: [{ node, bars }]; with `labels`, also the names
// of these nodes and of the `source` node (the repeater whose coverage is shown)
export function setLinkQuality(map, links, { labels = false, source = null } = {}) {
	const all = source && labels ? [{ node: source, bars: 0 }, ...links] : links;
	const features = all.map(({ node, bars }) => {
		const { lngLat, slot, reveal } = getNodePlacement(node);
		// lower first: the repeater, then the best links
		const properties = { bars, label: labels, name: node.adv_name, priority: node === source ? 0 : 4 - bars };
		if(slot !== undefined) Object.assign(properties, { slot, reveal });
		return { type: 'Feature', geometry: { type: 'Point', coordinates: lngLat }, properties };
	});
	map.overlays.set({ links: { type: 'FeatureCollection', features } });
}

// The overlay sources live on top of whichever base style is loaded. Switching the style
// replaces all sources, so their data is kept here and put into every newly loaded style.
function createOverlays(map) {
	const state = {
		nodes: emptyCollection(),
		bubbles: emptyCollection(),
		spread: emptyCollection(),
		spider: emptyCollection(),
		highlight: emptyCollection(),
		links: emptyCollection(),
		planning: emptyCollection(),
		clusterMaxZoom: clusterMaxZoomFor(DEFAULT_FILTERS.clusteringZoom),
		offsetExpression: getOffsetExpression(),
		labelOffsetExpression: getLabelOffsetExpression(),
		labelTheme: isDarkTheme() ? 'dark' : 'light',
		// names of all nodes when zoomed in close
		nodeNames: true,
		// image of a repeater's estimated coverage ({ url, coordinates }), or null
		coverage: null,
	};
	// what the style being loaded / currently loaded was built with
	let applied = { ...state };
	let loaded = false;

	function apply() {
		if(!loaded) return;
		for(const source of ['nodes', 'bubbles', 'spread', 'spider', 'highlight', 'links', 'planning']) {
			if(applied[source] !== state[source]) map.getSource(source).setData(state[source]);
		}
		if(applied.clusterMaxZoom !== state.clusterMaxZoom) {
			// options left out are reset, so `cluster` and the radius have to be passed again
			map.getSource('nodes').setClusterOptions({
				cluster: state.clusterMaxZoom >= 0,
				clusterRadius: CLUSTER_RADIUS,
				clusterMaxZoom: Math.max(0, state.clusterMaxZoom),
			});
			for(const id of UNCLUSTERED_LAYER_IDS) map.setLayerZoomRange(id, state.clusterMaxZoom + 1, 24);
		}
		if(applied.coverage !== state.coverage) {
			if(map.getLayer('coverage')) map.removeLayer('coverage');
			if(map.getSource('coverage')) map.removeSource('coverage');
			if(state.coverage) {
				map.addSource('coverage', coverageSource(state.coverage));
				// below all the node layers
				map.addLayer(COVERAGE_LAYER, 'highlight');
			}
		}
		if(applied.offsetExpression !== state.offsetExpression) {
			for(const id of ['spread-nodes', 'highlight', 'link-quality']) map.setLayoutProperty(id, 'icon-offset', state.offsetExpression);
		}
		if(applied.labelOffsetExpression !== state.labelOffsetExpression) {
			for(const id of ['node-labels', 'spread-node-names']) map.setLayoutProperty(id, 'icon-offset', state.labelOffsetExpression);
		}
		if(applied.labelTheme !== state.labelTheme) {
			for(const id of ['node-labels', 'node-names', 'spread-node-names']) {
				map.setLayoutProperty(id, 'icon-image', labelImageExpression(state.labelTheme));
			}
		}
		if(applied.nodeNames !== state.nodeNames) {
			for(const id of ['node-names', 'spread-node-names']) map.setLayoutProperty(id, 'visibility', state.nodeNames ? 'visible' : 'none');
		}
		applied = { ...state };
	}

	map.on('style.load', () => {
		loaded = true;
		apply();
	});

	return {
		addTo(style) {
			loaded = false;
			applied = { ...state };
			const withOverlays = {
				...style,
				sources: {
					...style.sources,
					highlight: { type: 'geojson', data: state.highlight },
					links: { type: 'geojson', data: state.links },
					planning: { type: 'geojson', data: state.planning },
					spider: { type: 'geojson', data: state.spider },
					spread: { type: 'geojson', data: state.spread },
					// group bubbles that would overlap are merged (until right before the closest zoom);
					// a merged bubble is revealed once all of its groups are
					bubbles: {
						type: 'geojson',
						data: state.bubbles,
						cluster: true,
						clusterRadius: GROUP_BUBBLE_SIZE,
						clusterMaxZoom: toMapZoom(MAX_APP_ZOOM) - 1,
						clusterProperties: {
							count: ['+', ['get', 'count']],
							reveal: ['max', ['get', 'reveal']],
						},
					},
					nodes: {
						type: 'geojson',
						data: state.nodes,
						// clusterMaxZoom -1: clustering switched off
						cluster: state.clusterMaxZoom >= 0,
						clusterRadius: CLUSTER_RADIUS,
						clusterMaxZoom: Math.max(0, state.clusterMaxZoom),
						// a group of overlapping nodes is a single point counting as several nodes
						clusterProperties: { count: ['+', ['get', 'count']] },
					},
				},
				layers: [...style.layers, ...(state.coverage ? [COVERAGE_LAYER] : []), ...createOverlayLayers(state)],
			};
			if(state.coverage) withOverlays.sources.coverage = coverageSource(state.coverage);
			return withOverlays;
		},
		set(changes) {
			Object.assign(state, changes);
			apply();
		},
	};
}

// Lets the user switch the base map, expands on hover/focus
class BaseMapControl {
	constructor(selected, onChange) {
		this.selected = selected;
		this.onChange = onChange;
	}

	onAdd() {
		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl base-map-control';
		this.container.tabIndex = 0;
		this.container.title = 'Base map';
		this.container.innerHTML = `<i class="base-map-icon">layers</i><div class="base-map-list"></div>`;

		const list = this.container.querySelector('.base-map-list');
		for(const name of Object.keys(BASE_MAPS)) {
			const label = document.createElement('label');
			label.className = 'radio';
			label.innerHTML = `<input type="radio" name="base-map"><span></span>`;
			label.querySelector('span').textContent = name;

			const input = label.querySelector('input');
			input.checked = name === this.selected;
			input.addEventListener('change', () => this.onChange(name));
			list.append(label);
		}

		return this.container;
	}

	onRemove() {
		this.container.remove();
	}
}

// Cycles the light/dark theme (auto -> light -> dark), the icon shows the current mode
class ThemeControl {
	onAdd() {
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'maplibregl-ctrl map-button theme-control';
		this.button.innerHTML = '<i></i>';
		this.button.addEventListener('click', () => this.render(cycleThemeMode()));
		this.render(getThemeMode());
		return this.button;
	}

	render(mode) {
		const { icon, label } = THEME_MODES[mode];
		this.button.querySelector('i').textContent = icon;
		this.button.title = `${label} (click to change)`;
		this.button.setAttribute('aria-label', label);
	}

	onRemove() {
		this.button.remove();
	}
}

export function createMap(elementId, { lat, lon, zoom }) {
	let baseMap = readBaseMapSelection();

	const map = new MapLibreMap({
		container: elementId,
		center: [lon, lat],
		zoom: toMapZoom(zoom),
		minZoom: toMapZoom(2),
		maxZoom: toMapZoom(MAX_APP_ZOOM),
		// the map stays north-up, like a classic slippy map
		dragRotate: false,
		pitchWithRotate: false,
		touchPitch: false,
		rollEnabled: false,
		attributionControl: { customAttribution: APP_ATTRIBUTION },
	});
	map.touchZoomRotate.disableRotation();
	map.keyboard.disableRotation();
	map.setMissingStyleImageResolver(id => resolveImage(map, id));

	const overlays = createOverlays(map);
	map.overlays = overlays;

	function loadBaseMap() {
		map.setStyle(BASE_MAPS[baseMap](), {
			diff: false,
			transformStyle: (previous, next) => overlays.addTo(next),
		});
	}

	map.addControl(new BaseMapControl(baseMap, name => {
		baseMap = name;
		try { localStorage.setItem('baseMapSelected', name); } catch {}
		loadBaseMap();
	}), 'bottom-left');
	// bottom corners stack upwards, so this one ends up above the base map switcher
	map.addControl(new ThemeControl(), 'bottom-left');

	// on narrow screens MapLibre shows the compact attribution expanded until the first drag,
	// covering the map buttons - start collapsed (the ⓘ button still expands it)
	map.once('load', () => {
		const attribution = map.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show');
		attribution?.classList.remove('maplibregl-compact-show');
		attribution?.removeAttribute('open');
	});

	onThemeChange(dark => {
		overlays.set({ labelTheme: dark ? 'dark' : 'light' });
		if(baseMap === 'OSM Vector' || baseMap === 'VersaTiles') loadBaseMap();
	});

	loadBaseMap();
	return map;
}

// Icons are drawn on demand from their id, at the device pixel ratio so they stay sharp
async function resolveImage(map, id) {
	const sep = id.indexOf('|');
	const kind = id.slice(0, sep);
	const arg = id.slice(sep + 1);

	let canvas;
	if(kind === 'type') {
		const [type, status] = arg.split('|');
		canvas = await drawTypeIcon(type, status);
	} else if(kind === 'label') {
		const colorEnd = arg.indexOf('|');
		canvas = drawLabelIcon(arg.slice(colorEnd + 1), arg.slice(0, colorEnd));
	} else if(kind === 'cluster') {
		canvas = drawClusterIcon(Number(arg));
	} else if(kind === 'leg') {
		canvas = drawSpiderLeg(Number(arg));
	} else if(kind === 'name') {
		const themeEnd = arg.indexOf('|');
		canvas = drawNodeLabel(arg.slice(themeEnd + 1), arg.slice(0, themeEnd));
	} else if(kind === 'bars') {
		canvas = await drawLinkBars(Number(arg));
	} else if(kind === 'plan') {
		canvas = drawPlanningPoint(arg);
	} else if(id === 'highlight-ring') {
		canvas = drawHighlightRing();
	} else {
		return;
	}

	// the resolver may be asked for the same image again while an earlier request was loading
	if(!map.hasImage(id)) {
		const ctx = canvas.getContext('2d');
		map.addImage(id, ctx.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: devicePixelRatio });
	}
}

function createCanvas(width, height = width) {
	const canvas = document.createElement('canvas');
	canvas.width = Math.ceil(width * devicePixelRatio);
	canvas.height = Math.ceil(height * devicePixelRatio);
	// every icon is read back with getImageData for map.addImage, so keep it in CPU memory
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	ctx.scale(devicePixelRatio, devicePixelRatio);
	return [canvas, ctx];
}

const typeImages = new Map();

function loadTypeImage(type) {
	let promise = typeImages.get(type);
	if(!promise) {
		const img = new Image();
		img.src = `img/node_types/${type}.svg`;
		promise = img.decode().then(() => img);
		typeImages.set(type, promise);
	}
	return promise;
}

async function drawTypeIcon(type, status) {
	const img = await loadTypeImage(type);
	const [canvas, ctx] = createCanvas(ICON_SIZE);
	const style = STATUS_ICON_STYLE[status];
	ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);
	// filtered pixel by pixel: Safari doesn't support ctx.filter
	if(style) {
		const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
		ctx.putImageData(applyCssFilter(pixels, style.filter, style.alpha), 0, 0);
	}

	if(style?.outline) {
		ctx.strokeStyle = style.outline;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(ICON_SIZE / 2, ICON_SIZE / 2, ICON_SIZE / 2 - 0.5, 0, Math.PI * 2);
		ctx.stroke();
	}
	return canvas;
}

// Coloured circle with initials/emoji, used for client nodes
function drawLabelIcon(text, color) {
	const [canvas, ctx] = createCanvas(ICON_SIZE);
	const r = ICON_SIZE / 2;
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(r, r, r, 0, Math.PI * 2);
	ctx.fill();

	ctx.fillStyle = '#fff';
	ctx.font = `bold ${ICON_SIZE * 150 / 512}px sans-serif`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, r, r);
	return canvas;
}

function drawClusterIcon(count) {
	const size = 40;
	const [, outer, inner] = CLUSTER_STYLES.find(([threshold]) => count < threshold);
	const [canvas, ctx] = createCanvas(size);
	const r = size / 2;

	for(const [radius, color] of [[r, outer], [r - 5, inner]]) {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(r, r, radius, 0, Math.PI * 2);
		ctx.fill();
	}

	ctx.fillStyle = '#000';
	ctx.font = '800 12px "Helvetica Neue", Arial, Helvetica, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(String(count), r, r + 1);
	return canvas;
}

// Horizontal line of the given length, rotated into place by the layer (anchored at its left end)
function drawSpiderLeg(length) {
	const height = 2;
	const [canvas, ctx] = createCanvas(length, height);
	ctx.fillStyle = SPIDER_LEG_COLOR;
	ctx.fillRect(0, 0, length, height);
	return canvas;
}

// signal bars icon per link quality, red / yellow / green
const LINK_BARS = {
	1: { glyph: 'signal_cellular_alt_1_bar', color: '#d32f2f' },
	2: { glyph: 'signal_cellular_alt_2_bar', color: '#f9a825' },
	3: { glyph: 'signal_cellular_alt', color: '#2e7d32' },
};
const LINK_BADGE_SIZE = 20;
const ICON_FONT = '"Material Symbols Outlined"';

// A small badge with the bars; the image is centred on the node, the badge sits at the icon's top right
async function drawLinkBars(bars) {
	const { glyph, color } = LINK_BARS[bars];
	const font = `${LINK_BADGE_SIZE - 4}px ${ICON_FONT}`;
	// the icon font may still be loading - the glyph is drawn from its ligature
	await document.fonts.load(font, glyph);

	const size = ICON_SIZE + LINK_BADGE_SIZE;
	const [canvas, ctx] = createCanvas(size);
	const center = size / 2 + ICON_SIZE / 2 - 4;
	const x = center, y = size - center;

	ctx.beginPath();
	ctx.arc(x, y, LINK_BADGE_SIZE / 2, 0, Math.PI * 2);
	ctx.fillStyle = '#fff';
	ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
	ctx.shadowBlur = 2;
	ctx.fill();
	ctx.shadowColor = 'transparent';

	ctx.fillStyle = color;
	ctx.font = font;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(glyph, x, y + 1);
	return canvas;
}

const LABEL_MAX_CHARS = 24;
const LABEL_STYLES = {
	light: { text: '#1c1b1f', halo: 'rgba(255, 255, 255, 0.95)' },
	dark: { text: '#f4eff4', halo: 'rgba(0, 0, 0, 0.9)' },
};

// Node name with a halo, so it stays readable on any map
function drawNodeLabel(name, theme) {
	const chars = [...name];
	const text = chars.length > LABEL_MAX_CHARS ? chars.slice(0, LABEL_MAX_CHARS - 1).join('') + '…' : name;
	const font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
	const halo = 3, height = 16;

	const measure = document.createElement('canvas').getContext('2d');
	measure.font = font;
	const width = Math.ceil(measure.measureText(text).width) + halo * 2;

	const [canvas, ctx] = createCanvas(width, height);
	const { text: color, halo: haloColor } = LABEL_STYLES[theme] ?? LABEL_STYLES.light;
	ctx.font = font;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.lineJoin = 'round';
	ctx.lineWidth = halo;
	ctx.strokeStyle = haloColor;
	ctx.strokeText(text, width / 2, height / 2);
	ctx.fillStyle = color;
	ctx.fillText(text, width / 2, height / 2);
	return canvas;
}

// Blue circle with a letter (profile ends), without one: a picked point (coverage)
function drawPlanningPoint(label) {
	const size = PLANNING_POINT_SIZE, r = size / 2;
	const [canvas, ctx] = createCanvas(size);
	ctx.fillStyle = PLANNING_COLOR;
	ctx.strokeStyle = '#fff';
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	ctx.arc(r, r, r - 1.5, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();
	ctx.fillStyle = '#fff';
	if(label) {
		ctx.font = `bold ${size * 0.5}px sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(label, r, r + 1);
	} else {
		ctx.beginPath();
		ctx.arc(r, r, size * 0.16, 0, Math.PI * 2);
		ctx.fill();
	}
	return canvas;
}

function drawHighlightRing() {
	const radius = 22, stroke = 3;
	const size = (radius + stroke) * 2;
	const [canvas, ctx] = createCanvas(size);
	ctx.beginPath();
	ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
	ctx.globalAlpha = 0.2;
	ctx.fillStyle = HIGHLIGHT_COLOR;
	ctx.fill();
	ctx.globalAlpha = 1;
	ctx.lineWidth = stroke;
	ctx.strokeStyle = HIGHLIGHT_COLOR;
	ctx.stroke();
	return canvas;
}

function getNodeIconId(node) {
	if(node.type === 1) {
		return `label|${getColourForName(node.adv_name)}|${getNameIconLabel(node.adv_name)}`;
	}
	return `type|${node.type}|${node.status}`;
}

// Feature properties have to be plain data, so features refer to their node by a stable index
const nodeRegistry = [];
const nodeFeatures = new WeakMap();

function getNodeFeature(node) {
	let feature = nodeFeatures.get(node);
	if(!feature) {
		feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [node.lon, node.lat] },
			// `count`: summed up by clusters, groups of overlapping nodes count as several nodes
			properties: { i: nodeRegistry.push(node) - 1, icon: getNodeIconId(node), name: node.adv_name ?? '', namePriority: node.type === 2 ? 0 : 1, count: 1 },
		};
		nodeFeatures.set(node, feature);
	}
	return feature;
}

// Position in world pixels at the closest zoom (web mercator)
function toMaxZoomPixels(node) {
	const scale = 512 * 2 ** toMapZoom(MAX_APP_ZOOM);
	const sinLat = Math.sin(node.lat * Math.PI / 180);
	return [
		(node.lon + 180) / 360 * scale,
		(0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
	];
}

// Groups of nodes that still overlap at the closest zoom (chains of nodes closer than SPIDER_OVERLAP_PX)
function findOverlappingGroups(nodes) {
	const points = nodes.map(toMaxZoomPixels);
	const parent = nodes.map((_, i) => i);
	const find = i => {
		while(parent[i] !== i) i = parent[i] = parent[parent[i]];
		return i;
	};

	// grid of SPIDER_OVERLAP_PX cells: overlapping nodes are in the same or a neighbouring cell
	const grid = new Map();
	points.forEach(([x, y], i) => {
		const cx = Math.floor(x / SPIDER_OVERLAP_PX), cy = Math.floor(y / SPIDER_OVERLAP_PX);
		for(let gx = cx - 1; gx <= cx + 1; gx++) {
			for(let gy = cy - 1; gy <= cy + 1; gy++) {
				for(const j of grid.get(`${gx},${gy}`) ?? []) {
					if(Math.hypot(points[j][0] - x, points[j][1] - y) < SPIDER_OVERLAP_PX) {
						parent[find(i)] = find(j);
					}
				}
			}
		}
		const key = `${cx},${cy}`;
		if(grid.has(key)) grid.get(key).push(i); else grid.set(key, [i]);
	});

	const groups = new Map();
	nodes.forEach((node, i) => {
		const root = find(i);
		if(groups.has(root)) groups.get(root).push(node); else groups.set(root, [node]);
	});
	return [...groups.values()].filter(group => group.length > 1);
}

// Screen pixel offsets around the shared point: a circle for a few nodes, a spiral for more
function getSpiderOffsets(count) {
	if(count <= SPIDER_MAX_CIRCLE_NODES) {
		const radius = Math.max(SPIDER_MIN_RADIUS, SPIDER_FOOT_SEPARATION * count / (2 * Math.PI));
		return Array.from({ length: count }, (_, i) => {
			const angle = Math.PI + 2 * Math.PI * i / count;
			return [radius * Math.cos(angle), radius * Math.sin(angle)];
		});
	}

	// Archimedean spiral: neighbouring nodes and the spiral's turns are both SPIDER_FOOT_SEPARATION apart
	const offsets = [];
	let radius = SPIDER_MIN_RADIUS, angle = 0;
	for(let i = 0; i < count; i++) {
		offsets.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
		angle += SPIDER_FOOT_SEPARATION / radius;
		radius = SPIDER_MIN_RADIUS + SPIDER_FOOT_SEPARATION / (2 * Math.PI) * angle;
	}
	return offsets;
}

// Style expressions can't build an array from feature properties (and array properties arrive as
// strings), so every distinct offset gets a numeric slot that `icon-offset` looks up in a match expression
const offsetSlots = [];
const offsetSlotKeys = new Map();
let offsetExpression = null;
let labelOffsetExpression = null;

function getOffsetSlot(key, offset) {
	let slot = offsetSlotKeys.get(key);
	if(slot === undefined) {
		slot = offsetSlots.push(offset) - 1;
		offsetSlotKeys.set(key, slot);
		offsetExpression = labelOffsetExpression = null;
	}
	return slot;
}

// Offset slots for a group of the given size; the spiral positions don't depend on the group size
function getSpiderSlots(count) {
	const circle = count <= SPIDER_MAX_CIRCLE_NODES;
	const offsets = getSpiderOffsets(count);
	return offsets.map((offset, i) => getOffsetSlot(circle ? `circle:${count}:${i}` : `spiral:${i}`, offset));
}

// `icon-offset` for the slot of each spread out node (shifted by `[dx, dy]`), the shift alone for the rest
function buildOffsetExpression([dx, dy]) {
	return offsetSlots.length === 0
		? ['literal', [dx, dy]]
		: ['match', ['coalesce', ['get', 'slot'], -1],
			...offsetSlots.flatMap(([x, y], slot) => [slot, ['literal', [x + dx, y + dy]]]),
			['literal', [dx, dy]]];
}

// a new object only when slots were added
function getOffsetExpression() {
	return offsetExpression ??= buildOffsetExpression([0, 0]);
}

// names go right below their node's icon
const LABEL_BASE_OFFSET = [0, ICON_SIZE / 2 + 2];

function getLabelOffsetExpression() {
	return labelOffsetExpression ??= buildOffsetExpression(LABEL_BASE_OFFSET);
}

// Where each spread out node is drawn: the shared point + a screen pixel offset, from its group's reveal zoom
let spiderPlacements = new WeakMap();
const placementListeners = new Set();

// Shared point + screen pixel offset a node is drawn at (the offset is [0, 0] for nodes that aren't spread out)
export function getNodePlacement(node) {
	return spiderPlacements.get(node) ?? { lngLat: [node.lon, node.lat], offset: [0, 0] };
}

// Map zoom at which the node can be seen on its own: at least the given app zoom, for a spread out node
// also its group's reveal zoom
export function getNodeFocusZoom(node, appZoom) {
	return Math.max(toMapZoom(appZoom), spiderPlacements.get(node)?.reveal ?? -Infinity);
}

function onPlacementsChange(listener) {
	placementListeners.add(listener);
}

// For every group, the lowest (integer) map zoom at which its spread out nodes don't overlap any neighbouring
// node or group: from that zoom on they are spread out, below it the group stays a cluster bubble.
// Distances shrink by half with every zoom level out, the spread (in screen pixels) stays the same size.
function computeRevealZooms(groups, singles) {
	const maxZoom = toMapZoom(MAX_APP_ZOOM);
	const minZoom = toMapZoom(SPIDER_MIN_REVEAL_APP_ZOOM);
	const items = [
		...groups.map(group => ({ point: group.point, radius: group.radius, group })),
		...singles.map(node => ({ point: toMaxZoomPixels(node), radius: ICON_SIZE / 2 })),
	];

	// neighbours further away than this (pixels at the closest zoom) are clear at every zoom from minZoom on
	const maxRadius = Math.max(ICON_SIZE / 2, ...groups.map(group => group.radius));
	const reach = (maxRadius * 2 + SPIDER_CLEAR_GAP) * 2 ** (maxZoom - minZoom);
	const cellSize = 1024;
	const grid = new Map();
	for(const item of items) {
		const key = `${Math.floor(item.point[0] / cellSize)},${Math.floor(item.point[1] / cellSize)}`;
		if(grid.has(key)) grid.get(key).push(item); else grid.set(key, [item]);
	}

	const cells = Math.ceil(reach / cellSize);
	for(const group of groups) {
		const [x, y] = group.point;
		const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
		let reveal = minZoom;
		for(let gx = cx - cells; gx <= cx + cells; gx++) {
			for(let gy = cy - cells; gy <= cy + cells; gy++) {
				for(const item of grid.get(`${gx},${gy}`) ?? []) {
					if(item.group === group) continue;
					const distance = Math.hypot(item.point[0] - x, item.point[1] - y);
					const needed = group.radius + item.radius + SPIDER_CLEAR_GAP;
					reveal = Math.max(reveal, distance > 0 ? maxZoom + Math.log2(needed / distance) : maxZoom);
				}
			}
		}
		group.reveal = Math.min(maxZoom, Math.ceil(reveal));
	}
}

// Features for the given nodes: single nodes + one point per group of overlapping nodes (clustered source),
// the group members spread around their shared point, and the lines connecting them
function buildNodeData(nodes, clustering) {
	spiderPlacements = new WeakMap();
	const grouped = findOverlappingGroups(nodes);
	const inGroup = new Set(grouped.flat());

	const groups = grouped.map(members => {
		const lngLat = [
			members.reduce((sum, node) => sum + node.lon, 0) / members.length,
			members.reduce((sum, node) => sum + node.lat, 0) / members.length,
		];
		const slots = getSpiderSlots(members.length);
		const radius = Math.max(...slots.map(slot => Math.hypot(...offsetSlots[slot]))) + ICON_SIZE / 2;
		return { members, lngLat, slots, radius, point: toMaxZoomPixels({ lon: lngLat[0], lat: lngLat[1] }) };
	});
	const singles = nodes.filter(node => !inGroup.has(node));
	if(clustering) {
		computeRevealZooms(groups, singles);
	} else {
		// nothing is clustered: overlapping nodes are always spread out
		for(const group of groups) group.reveal = 0;
	}

	const nodeFeatures = singles.map(getNodeFeature);
	const bubbleFeatures = [];
	const spreadFeatures = [];
	const spiderFeatures = [];

	groups.forEach(({ members, lngLat, slots, reveal }) => {
		const geometry = { type: 'Point', coordinates: lngLat };
		const group = { type: 'Feature', geometry, properties: { group: true, count: members.length, reveal } };
		// counted by the node clusters, drawn from the bubble source
		nodeFeatures.push(group);
		bubbleFeatures.push(group);
		spiderFeatures.push({ type: 'Feature', geometry, properties: { reveal } });

		members.forEach((node, i) => {
			const slot = slots[i];
			const offset = offsetSlots[slot];
			spiderPlacements.set(node, { lngLat, offset, slot, reveal });
			spreadFeatures.push({
				type: 'Feature',
				geometry,
				properties: { ...getNodeFeature(node).properties, slot, reveal },
			});
			spiderFeatures.push({
				type: 'Feature',
				geometry,
				properties: {
					leg: `leg|${Math.round(Math.hypot(...offset))}`,
					angle: Math.atan2(offset[1], offset[0]) * 180 / Math.PI,
					reveal,
				},
			});
		});
	});

	return {
		nodes: { type: 'FeatureCollection', features: nodeFeatures },
		bubbles: { type: 'FeatureCollection', features: bubbleFeatures },
		spread: { type: 'FeatureCollection', features: spreadFeatures },
		spider: { type: 'FeatureCollection', features: spiderFeatures },
		offsetExpression: getOffsetExpression(),
		labelOffsetExpression: getLabelOffsetExpression(),
	};
}

// topmost first, like they are drawn
const QUERY_LAYERS = ['spread-nodes', 'groups', 'nodes', 'clusters'];

// Topmost node, group or cluster at the point; the layers are missing while a new base style loads
function queryTopFeature(map, point) {
	if(!map.getLayer('nodes')) return null;
	return map.queryRenderedFeatures(point, { layers: QUERY_LAYERS })[0] ?? null;
}

// share of the screen the members of a clicked cluster should fill
const CLUSTER_ZOOM_FILL = 0.8;

// Zooms so the cluster's members (nodes, groups) fill most of the screen - but at least until it splits up
async function zoomIntoCluster(map, cluster) {
	const source = map.getSource('nodes');
	const clusterId = cluster.properties.cluster_id;
	const [leaves, expansionZoom] = await Promise.all([
		source.getClusterLeaves(clusterId, Infinity, 0),
		source.getClusterExpansionZoom(clusterId),
	]);

	const bounds = new LngLatBounds();
	for(const leaf of leaves) bounds.extend(leaf.geometry.coordinates);

	// the members' area fills CLUSTER_ZOOM_FILL of the screen, below the stats bar + search box
	const { width, height } = map.getContainer().getBoundingClientRect();
	const top = getTopOverlayBottom();
	const marginX = width * (1 - CLUSTER_ZOOM_FILL) / 2;
	const marginY = (height - top) * (1 - CLUSTER_ZOOM_FILL) / 2;
	const camera = map.cameraForBounds(bounds, {
		padding: { top: top + marginY, bottom: marginY, left: marginX, right: marginX },
		maxZoom: map.getMaxZoom(),
	});

	if(!camera || camera.zoom < expansionZoom) {
		map.easeTo({ center: cluster.geometry.coordinates, zoom: expansionZoom });
	} else {
		map.easeTo({ center: camera.center, zoom: camera.zoom });
	}
}

const isNodeFeature = feature => feature?.layer.id === 'nodes' || feature?.layer.id === 'spread-nodes';

// Clustered node markers. Clicking a cluster zooms into it, clicking a group zooms until its nodes
// are spread out, clicking a node calls onNodeClick.
export function createNodeLayer(map, { clusteringZoom, onNodeClick }) {
	const container = map.getContainer();
	let clusterMaxZoom = clusterMaxZoomFor(clusteringZoom);

	map.on('click', ev => {
		const feature = queryTopFeature(map, ev.point);
		if(!feature) return;

		if(isNodeFeature(feature)) {
			onNodeClick(nodeRegistry[feature.properties.i]);
			return;
		}

		const center = feature.geometry.coordinates;
		// a group bubble (possibly several merged): zoom in until all of its nodes are spread out
		if(feature.layer.id === 'groups') {
			map.easeTo({ center, zoom: Math.max(feature.properties.reveal, clusterMaxZoom + 1) });
			return;
		}

		zoomIntoCluster(map, feature).catch(console.error);
	});

	// hover cursor + native tooltip with the node name
	map.on('mousemove', ev => {
		const feature = queryTopFeature(map, ev.point);
		const node = isNodeFeature(feature) ? nodeRegistry[feature.properties.i] : null;
		container.classList.toggle('cluster-hover', !!feature && !node);
		container.classList.toggle('node-hover', !!node);
		map.getCanvas().title = node?.adv_name ?? '';
	});

	let clustering = true;
	let nodes = [];

	function rebuild() {
		map.overlays.set({ ...buildNodeData(nodes, clustering), clusterMaxZoom: clustering ? clusterMaxZoom : -1 });
		for(const listener of placementListeners) listener();
	}

	const layer = {
		setNodes(next) {
			nodes = next;
			rebuild();
		},
		setClusteringZoom(zoom) {
			clusterMaxZoom = clusterMaxZoomFor(zoom);
			if(clustering) map.overlays.set({ clusterMaxZoom });
		},
		// without clustering every node is shown on its own, overlapping ones always spread out
		setClustering(enabled, next = nodes) {
			const changed = enabled !== clustering || next !== nodes;
			clustering = enabled;
			nodes = next;
			if(changed) rebuild();
		},
	};

	layer.setClusteringZoom(clusteringZoom);
	return layer;
}

// Space taken by the stats bar + search box overlaying the top of the map
function getTopOverlayBottom() {
	// measure the fixed parts only - the search results list may be open when the popup gets opened
	return Math.max(0, ...['#app .stats', '#app .search > .field']
		.map(selector => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0));
}

// Where the panel at the bottom of the screen (the profile) starts, if one is open
function getBottomOverlayTop() {
	return document.querySelector('#app .profile-panel')?.getBoundingClientRect().top ?? Infinity;
}

// The part of the screen a popup may use (viewport coordinates): not cut off by the screen edges
// (the map can be taller than the visible area on mobile) nor covered by the overlays at the top and bottom
function getPopupArea(map) {
	const margin = 10;
	const mapBox = map.getContainer().getBoundingClientRect();
	return {
		top: Math.max(mapBox.top, getTopOverlayBottom()) + margin,
		// room for the attribution bar
		bottom: Math.min(mapBox.bottom - 30, innerHeight - 30, getBottomOverlayTop() - margin),
		left: mapBox.left + margin,
		right: Math.min(mapBox.right, innerWidth) - margin,
	};
}

// Pans the map so the popup fits the popup area; when it's too tall, its top stays visible
function panPopupIntoView(map, popup) {
	const box = popup.getElement().getBoundingClientRect();
	const area = getPopupArea(map);

	let dx = 0, dy = 0;
	if(box.right > area.right) dx = box.right - area.right;
	if(box.left - dx < area.left) dx = box.left - area.left;
	if(box.bottom > area.bottom) dy = box.bottom - area.bottom;
	if(box.top - dy < area.top) dy = box.top - area.top;

	if(dx || dy) map.panBy([dx, dy]);
}

const POPUP_OFFSET = 16;
// the popup's arrow pointing at the node
const POPUP_TIP_SIZE = 10;

// Renders the popup content off-screen to find out how tall the popup will be
function measurePopupHeight(map, html) {
	const probe = document.createElement('div');
	probe.className = 'maplibregl-popup node-popup';
	probe.style.cssText = 'position: absolute; visibility: hidden; top: 0; left: 0;';
	probe.innerHTML = `<div class="maplibregl-popup-content">${html}</div>`;
	map.getContainer().append(probe);
	const height = probe.getBoundingClientRect().height;
	probe.remove();
	return height + POPUP_TIP_SIZE;
}

// Opens the popup above the node when it fits there, otherwise below it; when it fits neither way,
// on the side with more room (and the map gets panned)
function choosePopupAnchor(map, placement, html) {
	const height = measurePopupHeight(map, html) + POPUP_OFFSET;
	const area = getPopupArea(map);
	const y = map.getContainer().getBoundingClientRect().top + map.project(placement.lngLat).y + placement.offset[1];
	const above = y - area.top;
	const below = area.bottom - y;

	if(above >= height) return 'bottom';
	if(below >= height) return 'top';
	return above >= below ? 'bottom' : 'top';
}

// A single node info popup; content is rendered on every open, so it reflects the current state
export function createNodePopup(map, { onOpen, onClose }) {
	let popup = null;
	let popupNode = null;

	function close() {
		popup?.remove();
	}

	return {
		open(node) {
			close();

			const html = getNodePopupHTML(node);
			// a spread out node is drawn away from its shared point - the popup points at its icon
			const placement = getNodePlacement(node);
			const anchor = choosePopupAnchor(map, placement, html);
			const [dx, dy] = placement.offset;
			const current = new Popup({
				anchor,
				offset: [dx, dy + (anchor === 'bottom' ? -POPUP_OFFSET : POPUP_OFFSET)],
				maxWidth: 'none',
				className: 'node-popup',
				focusAfterOpen: false,
			})
				.setLngLat(placement.lngLat)
				.setHTML(html);

			current.on('close', () => {
				if(popup === current) {
					popup = null;
					popupNode = null;
				}
				onClose(node);
			});

			popup = current;
			popupNode = node;
			current.addTo(map);
			// content can grow (e.g. the public key expands) - keep the popup in view; the delegated
			// click handler on the document changes the content after this listener, hence the next frame
			current.getElement().addEventListener('click', () => {
				requestAnimationFrame(() => {
					if(popup === current) panPopupIntoView(map, current);
				});
			});
			onOpen(node);
			panPopupIntoView(map, current);
		},
		close,
		// re-renders the open popup, e.g. once data it shows has finished loading
		refresh() {
			if(!popup) return;
			popup.setHTML(getNodePopupHTML(popupNode));
			// the popup may have grown
			panPopupIntoView(map, popup);
		},
	};
}

// Rings around the given nodes, drawn below the markers (around the icon of spread out nodes)
export function createHighlightLayer(map) {
	let nodes = [];
	let visible = false;

	function update() {
		const features = visible ? nodes.map(node => {
			const { lngLat, slot } = getNodePlacement(node);
			return {
				type: 'Feature',
				geometry: { type: 'Point', coordinates: lngLat },
				properties: slot === undefined ? {} : { slot },
			};
		}) : [];
		map.overlays.set({ highlight: { type: 'FeatureCollection', features } });
	}

	// nodes get spread out differently when the visible nodes change
	onPlacementsChange(update);

	return {
		setNodes(next) {
			nodes = next;
			update();
		},
		setVisible(next) {
			visible = next;
			update();
		},
	};
}
