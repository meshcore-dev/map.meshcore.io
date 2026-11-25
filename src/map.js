import { LngLatBounds, Map as MapLibreMap, Marker, MercatorCoordinate, Popup } from '../lib/maplibre-gl.mjs';
import { DEFAULT_FILTERS, MAPTILER_KEY } from './config.js';
import { getColourForName, getNameIconLabel } from './node-utils.js';
import { applyCssFilter, compassPoint } from './utils.js';
import { getNodePopupHTML } from './popup.js';
import { OPENTOPOMAP_BOUNDS, OPENTOPOMAP_HOME, getOpenTopoMapStyle } from './opentopomap.js';
import { addHorizonCutoff } from './horizon-cutoff.js';
import { THEME_MODES, cycleThemeMode, getThemeMode, isDarkTheme, onThemeChange } from './theme.js';

const APP_ATTRIBUTION = `
	App: recrof, <a target="_blank" href="https://github.com/sponsors/recrof?frequency=one-time&sponsor=recrof">
	<strong>support my work</strong></a> |
	<a href="#deletion-request"><strong>Node deletion request</strong></a>
`;
// (MapLibre sanitizes attribution HTML and drops data-* attributes, so the link is recognised by its href)

// Base map styles (a style URL or object, or a promise of one); the vector maps follow the app's
// light/dark theme
const BASE_MAPS = {
	// OpenStreetMap data as vector tiles (OpenFreeMap)
	'OSM Vector': () => `https://tiles.openfreemap.org/styles/${isDarkTheme() ? 'dark' : 'liberty'}`,
	// OpenStreetMap data as vector tiles (VersaTiles), more detailed dark theme
	'VersaTiles': () => `https://tiles.versatiles.org/assets/styles/${isDarkTheme() ? 'colorful-dark' : 'colorful'}/style.json`,
	// satellite imagery with VersaTiles' streets, borders and names on top (hybrid)
	'Satellite': getHybridSatelliteStyle,
	// MapTiler, with their dark versions
	'MapTiler Topo': () => mapTilerStyle(isDarkTheme() ? 'topo-v4-dark' : 'topo-v4'),
	'MapTiler OSM': () => mapTilerStyle(isDarkTheme() ? 'openstreetmap-dark' : 'openstreetmap'),
	// topographic: contour lines, hillshade and elevation colours (the style is loaded first: async);
	// Europe only
	'OpenTopoMap (Europe)': getOpenTopoMapStyle,
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
const DEFAULT_BASE_MAP = 'VersaTiles';

const SATELLITE_SOURCE = {
	type: 'raster',
	tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
	tileSize: 256,
	// highest tile zoom provided, the map overzooms past it
	maxzoom: 18,
	attribution: 'Tiles: &copy; Esri | Sources: Esri, DigitalGlobe, GeoEye, i-cubed, USDA FSA, USGS, AEX, Getmapping, Aerogrid, IGN, IGP, swisstopo, GIS Users',
};
const HYBRID_STREETS_STYLE = 'https://tiles.versatiles.org/assets/styles/colorful/style.json';
// left out over the imagery: everything under the streets (land, water, buildings: the photo shows
// them), areas (pedestrian zones, bridges), tunnels, road outlines, points of interest and house numbers
const HYBRID_SKIPPED_LAYERS = /^(tunnel-|poi-|label-address)|:outline$/;
const HYBRID_STREET_OPACITY = 0.6;

// Satellite imagery under the streets, railways, borders and labels of VersaTiles' style (just the
// imagery when that style can't be loaded); the labels are white with a dark halo
async function getHybridSatelliteStyle() {
	const imagery = { id: 'satellite', type: 'raster', source: 'satellite' };
	let streets;
	try {
		const response = await fetch(HYBRID_STREETS_STYLE);
		if(!response.ok) throw new Error(`HTTP ${response.status}`);
		streets = await response.json();
	} catch(error) {
		console.error('Hybrid satellite map: no streets and labels', error);
		return { version: 8, sources: { satellite: SATELLITE_SOURCE }, layers: [imagery] };
	}
	const start = streets.layers.findIndex(layer => layer.id === 'slot-below-streets') + 1;
	const layers = streets.layers.slice(start)
		.filter(layer => layer.type !== 'background' && layer.type !== 'fill' && !HYBRID_SKIPPED_LAYERS.test(layer.id))
		.map(layer => {
			if(layer.type === 'line' && layer['source-layer'] === 'streets') {
				return { ...layer, paint: { ...layer.paint, 'line-opacity': HYBRID_STREET_OPACITY } };
			}
			// text labels (not the road shields, which have their own background)
			if(layer.type === 'symbol' && layer.layout?.['text-field'] && !layer.layout['icon-image']) {
				return { ...layer, paint: { ...layer.paint, 'text-color': '#fff', 'text-halo-color': 'rgba(0, 0, 0, 0.75)', 'text-halo-width': 1.5 } };
			}
			return layer;
		});
	return {
		...streets,
		sources: { ...streets.sources, satellite: SATELLITE_SOURCE },
		layers: [imagery, ...layers],
	};
}
// base map names stored by earlier versions of the app
// MapTiler's logo has to be on the map while their maps are shown
const MAPTILER_BASE_MAPS = new Set(['MapTiler Topo', 'MapTiler OSM']);

// base maps with a light and a dark version
const THEMED_BASE_MAPS = new Set(['OSM Vector', 'VersaTiles', ...MAPTILER_BASE_MAPS]);

function mapTilerStyle(name) {
	return `https://api.maptiler.com/maps/${name}/style.json?key=${MAPTILER_KEY}`;
}

const LEGACY_BASE_MAPS = { 'OpenStreetMap': 'OSM Vector', 'Map': 'OSM Vector', 'Esri Satellite': 'Satellite', 'OpenTopoMap': 'OpenTopoMap (Europe)' };
// base maps covering only part of the world: the map can't be moved out of it ([west, south, east, north])
const BASE_MAP_BOUNDS = { 'OpenTopoMap (Europe)': OPENTOPOMAP_BOUNDS };
// where such a map is shown when picked with the view outside it (or zoomed out further)
const BASE_MAP_HOME = { 'OpenTopoMap (Europe)': OPENTOPOMAP_HOME };

// zoomed out further, the map's limits would push the view off the home area's centre
const BASE_MAP_HOME_MIN_ZOOM = 4.5;

// Keeps the view within a base map's limits (bounds), showing its home ({ area, center }) when centred elsewhere or
// zoomed out further. Decided before the limits apply: they move the map silently (no move events,
// so the URL wouldn't follow) - a jump to where it ended up sends them.
function applyBaseMapLimits(map, bounds, home) {
	if(home) {
		const [west, south, east, north] = home.area;
		const camera = map.cameraForBounds([[west, south], [east, north]]);
		const { lng, lat } = map.getCenter();
		const outside = lng < west || lng > east || lat < south || lat > north;
		if(camera && (outside || map.getZoom() < camera.zoom)) {
			map.jumpTo({ center: home.center, zoom: Math.max(camera.zoom, BASE_MAP_HOME_MIN_ZOOM) });
		}
	}
	const before = map.getCenter(), zoom = map.getZoom();
	map.setMaxBounds(bounds);
	if(!map.getCenter().equals?.(before) || map.getZoom() !== zoom) map.jumpTo({ center: map.getCenter(), zoom: map.getZoom() });
}

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

// coverage lines (the estimate's edge, a directional antenna's direction): white dashes outlined in
// black. MapLibre's line-dasharray can't do this: its dashes are in line widths and change while zooming
// (so a wider black line's dashes never quite match), and restart at tile edges. Instead the dashes are
// cut here, in screen pixels (see dashCoverageLines), and both layers draw the same pieces.
const COVERAGE_DASH = 12, COVERAGE_GAP = 8;
const COVERAGE_LINE_LAYERS = [
	{
		id: 'coverage-lines-outline',
		type: 'line',
		source: 'coverageLines',
		// square caps: the outline goes around the ends of the dashes too
		layout: { 'line-cap': 'square' },
		paint: { 'line-color': '#000', 'line-width': 4 },
	},
	{
		id: 'coverage-lines',
		type: 'line',
		source: 'coverageLines',
		layout: { 'line-cap': 'butt' },
		paint: { 'line-color': '#fff', 'line-width': 2 },
	},
];

// Mountain peaks with their name and height (OpenFreeMap's OpenMapTiles vector tiles), on base maps
// that don't show them. Drawn as images (like the node names): raster base maps have no fonts. In the
// 3D view each stands on a stick, so it's clear which summit it is.
const PEAKS_LAYER_ID = 'peaks';
const PEAKS_SOURCE = { type: 'vector', url: 'https://tiles.openfreemap.org/planet' };
// base maps with peaks of their own (the vector ones are found by their mountain_peak layers)
const BASE_MAPS_WITH_PEAKS = new Set(['OSM Standard']);
// brown, like the peaks on openstreetmap.org
const PEAK_STYLES = {
	light: { text: '#9a6436', halo: 'rgba(255, 255, 255, 0.95)' },
	dark: { text: '#dcae80', halo: 'rgba(0, 0, 0, 0.85)' },
};

// Parts of the map that can be hidden (base map layers by their vector tile layer: VersaTiles' and
// OpenTopoMap's Shortbread, OpenMapTiles in the others; raster maps have them in the picture)
const MAP_LAYER_GROUPS = [
	{ id: 'peaks', label: 'Peaks and heights', sourceLayers: ['mountain_peak'], layerIds: [PEAKS_LAYER_ID] },
	{ id: 'places', label: 'Place names', sourceLayers: ['place_labels', 'place'] },
	{ id: 'roads', label: 'Roads and railways', sourceLayers: [
		'streets', 'street_polygons', 'street_labels', 'street_labels_points', 'streets_polygons_labels', 'bridges',
		'aerialways', 'ferries', 'transportation', 'transportation_name',
	] },
	{ id: 'borders', label: 'Borders', sourceLayers: ['boundaries', 'boundary_labels', 'boundary'] },
];

function mapLayerGroup(layer) {
	return MAP_LAYER_GROUPS.find(group => group.layerIds?.includes(layer.id) || group.sourceLayers.includes(layer['source-layer']))?.id ?? null;
}

function readShownMapLayers() {
	let saved = {};
	try { saved = JSON.parse(localStorage.getItem('mapLayers')) ?? {}; } catch {}
	return Object.fromEntries(MAP_LAYER_GROUPS.map(group => [group.id, saved[group.id] !== false]));
}
const PEAK_STICK_HEIGHT = 36;

function peakImageExpression(theme, stick) {
	return ['concat', 'peak|', theme, '|', stick ? '1' : '0', '|', ['to-string', ['round', ['get', 'ele']]], '|', ['get', 'name']];
}

function peakLayer(theme, view3d) {
	return {
		id: PEAKS_LAYER_ID,
		type: 'symbol',
		source: PEAKS_LAYER_ID,
		'source-layer': 'mountain_peak',
		// in the 3D view the distant ones (on lower zoom tiles) too
		minzoom: view3d ? 7 : 9,
		filter: ['all', ['in', ['get', 'class'], ['literal', ['peak', 'volcano']]], ['has', 'name'], ['has', 'ele']],
		layout: {
			'icon-image': peakImageExpression(theme, view3d),
			// the triangle's tip (or the stick's foot) on the summit
			'icon-anchor': 'bottom',
			'icon-pitch-alignment': 'viewport',
			'icon-rotation-alignment': 'viewport',
			'icon-allow-overlap': false,
			// the highest first
			'symbol-sort-key': ['-', 0, ['get', 'ele']],
		},
	};
}

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
		// right above the coverage image, below the nodes
		...COVERAGE_LINE_LAYERS,
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
			// red where the line of sight is blocked
			paint: { 'line-color': ['case', ['get', 'blocked'], HIGHLIGHT_COLOR, PLANNING_COLOR], 'line-width': 3, 'line-dasharray': [2, 1.5] },
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

// coverage images: one per site (`coverage-<id>`), and where they overlap (`coverage-overlap`)
const OVERLAP_LAYER_ID = 'coverage-overlap';
// opacity of the selected site's image, the others', and all of them while overlaps are highlighted
const COVERAGE_OPACITY = { active: 1, other: 0.6, dimmed: 0.3 };

function coverageImageLayers({ sites, overlap }) {
	const layers = sites.map(site => ({
		id: `coverage-${site.id}`,
		type: 'raster',
		source: `coverage-${site.id}`,
		paint: { 'raster-fade-duration': 0, 'raster-opacity': coverageOpacity(site, overlap) },
	}));
	if(overlap) layers.push({ id: OVERLAP_LAYER_ID, type: 'raster', source: OVERLAP_LAYER_ID, paint: { 'raster-fade-duration': 0 } });
	return layers;
}
function coverageOpacity(site, overlap) {
	return overlap ? COVERAGE_OPACITY.dimmed : site.active ? COVERAGE_OPACITY.active : COVERAGE_OPACITY.other;
}
function coverageImageSources({ sites, overlap }) {
	const sources = Object.fromEntries(sites.map(({ id, result: { url, coordinates } }) => [`coverage-${id}`, { type: 'image', url, coordinates }]));
	if(overlap) sources[OVERLAP_LAYER_ID] = { type: 'image', url: overlap.url, coordinates: overlap.coordinates };
	return sources;
}

// Shows the estimated coverage images below the nodes: sites [{ id, active, result }] (results from
// computeCoverage), the selected one stronger, and where two or more of them reach (`overlap` from
// computeOverlap, or null): then the sites' own images are dimmed
export function setCoverageOverlay(map, { sites = [], overlap = null } = {}) {
	map.coverageLineShapes = sites.flatMap(site => coverageLineShapes(site.result.lines));
	map.overlays.set({ coverage: { sites, overlap }, coverageLines: dashCoverageLines(map) });
}

// The estimate's edge (a circle on the map, like the estimate's rays) and, for a directional antenna,
// a line to it in the direction it points: [[lngLat, ...], ...]
function coverageLineShapes({ center, radius, bearing = null }) {
	const origin = MercatorCoordinate.fromLngLat(center);
	const r = radius * origin.meterInMercatorCoordinateUnits();
	const at = angle => {
		const { lng, lat } = new MercatorCoordinate(origin.x + Math.sin(angle) * r, origin.y - Math.cos(angle) * r).toLngLat();
		return [lng, lat];
	};
	// fine enough to look round zoomed in close (a few metres off at 250 km)
	const circle = Array.from({ length: 721 }, (_, i) => at(i / 720 * 2 * Math.PI));
	const shapes = [circle];
	if(bearing !== null) shapes.push([center, at(bearing * Math.PI / 180)]);
	return shapes;
}

// The coverage line shapes cut into dashes of COVERAGE_DASH screen pixels at the current view (redone
// when the map stops moving). Only around the visible part, so there aren't too many zoomed in close.
function dashCoverageLines(map) {
	const shapes = map.coverageLineShapes ?? [];
	if(!shapes.length) return emptyCollection();
	const { clientWidth: width, clientHeight: height } = map.getContainer();
	const margin = Math.max(width, height);
	const box = { left: -margin, top: -margin, right: width + margin, bottom: height + margin };
	const period = COVERAGE_DASH + COVERAGE_GAP;
	const dashes = [];
	for(const shape of shapes) {
		const points = shape.map(lngLat => map.project(lngLat));
		// where in the dash pattern the line is, and the dash being drawn
		let phase = 0, dash = null;
		const endDash = () => {
			if(dash) dashes.push(dash);
			dash = null;
		};
		for(let i = 1; i < points.length; i++) {
			const p = points[i - 1], q = points[i];
			const length = Math.hypot(q.x - p.x, q.y - p.y);
			if(!(length > 0) || !Number.isFinite(length)) {
				endDash();
				continue;
			}
			// only the part around the view gets dashes: in a tilted 3D view a segment towards the
			// horizon can be millions of pixels long on the screen
			const span = clipSegment(p, q, box);
			if(!span) {
				endDash();
				phase = (phase + length) % period;
				continue;
			}
			const [from, to] = span.map(share => share * length);
			if(from > 0) endDash();
			// the spot `t` screen pixels along the segment, on the map (the segment is short: in between)
			const a = shape[i - 1], b = shape[i];
			const at = t => [a[0] + (b[0] - a[0]) * t / length, a[1] + (b[1] - a[1]) * t / length];
			phase = (phase + from) % period;
			for(let t = from; t < to;) {
				const inDash = phase < COVERAGE_DASH;
				const step = Math.min(to - t, (inDash ? COVERAGE_DASH : period) - phase);
				if(inDash) {
					dash ??= [at(t)];
					dash.push(at(t + step));
				}
				t += step;
				phase += step;
				if(phase >= period - 1e-9) phase = 0;
				// the dash ended within this segment
				if(dash && phase >= COVERAGE_DASH) endDash();
			}
			if(to < length) {
				endDash();
				phase = (phase + length - to) % period;
			}
		}
		endDash();
	}
	return { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: dashes }, properties: {} };
}

// The part of the screen segment p-q inside `box` ({ left, top, right, bottom }) as shares of the
// segment [from, to], or null (Liang-Barsky)
function clipSegment(p, q, { left, top, right, bottom }) {
	const dx = q.x - p.x, dy = q.y - p.y;
	let from = 0, to = 1;
	for(const [denominator, distance] of [[-dx, p.x - left], [dx, right - p.x], [-dy, p.y - top], [dy, bottom - p.y]]) {
		if(denominator === 0) {
			if(distance < 0) return null;
			continue;
		}
		const share = distance / denominator;
		if(denominator < 0) from = Math.max(from, share);
		else to = Math.min(to, share);
		if(from > to) return null;
	}
	return [from, to];
}

// Planning marks: points ([{ lngLat, label, site }], label '' for a plain point, site: the coverage site's
// id), the line between the profile ends ([lngLat, lngLat] or null) with the parts where the line of
// sight is blocked ([[from, to], ...] as shares of the line, drawn red) and a highlighted spot on it
// (lngLat or null)
export function setPlanningOverlay(map, { points = [], line = null, blocked = [], hover = null } = {}) {
	const features = [];
	if(line) {
		const piece = (from, to, isBlocked) => features.push({
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: [interpolateMapLine(line[0], line[1], from), interpolateMapLine(line[0], line[1], to)] },
			properties: { kind: 'line', blocked: isBlocked },
		});
		let at = 0;
		for(const [from, to] of blocked) {
			if(from > at) piece(at, from, false);
			piece(from, to, true);
			at = to;
		}
		if(at < 1) piece(at, 1, false);
	}
	for(const { lngLat, label, site = null } of points) {
		features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: lngLat }, properties: { kind: 'point', label, site } });
	}
	if(hover) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: hover }, properties: { kind: 'hover' } });
	map.overlays.set({ planning: { type: 'FeatureCollection', features } });
}

// Pin on a place or point picked in the search; onClick({ lat, lon }, label, event) when it's clicked
export function createSearchPin(map, { onClick }) {
	let marker = null;
	function clear() {
		marker?.remove();
		marker = null;
	}
	function show({ lat, lon }, label) {
		clear();
		marker = new Marker({ color: '#e53935', className: 'search-pin' }).setLngLat([lon, lat]).addTo(map);
		const element = marker.getElement();
		element.title = label;
		element.addEventListener('click', ev => {
			ev.stopPropagation();
			onClick({ lat, lon }, label, ev);
		});
	}
	return { show, clear };
}

// Turn handle of a directional antenna: a knob a bit away from the antenna in the direction it points
// (on the coverage's direction line), to drag it around (screen angles plus the map's bearing, which
// is only turned in the 3D view; its tilt is left out), and the bearing next to it. onTurn(bearing) when the knob is let go.
const DIRECTION_ARM_LENGTH = 64;

export class DirectionHandle {
	constructor(map, onTurn) {
		this.map = map;
		this.onTurn = onTurn;
		this.bearing = 0;
		this.element = document.createElement('div');
		this.element.className = 'direction-handle';
		this.element.innerHTML = `
			<button type="button" class="direction-knob" title="Drag to turn the antenna" aria-label="Turn the antenna"><i>sync</i></button>
			<span class="direction-label"></span>`;
		this.knob = this.element.querySelector('.direction-knob');
		this.label = this.element.querySelector('.direction-label');
		this.marker = new Marker({ element: this.element, anchor: 'center' });

		// the map would pan with the knob
		for(const type of ['mousedown', 'touchstart', 'dblclick', 'click']) this.knob.addEventListener(type, ev => ev.stopPropagation());
		this.knob.addEventListener('pointerdown', ev => {
			ev.preventDefault();
			this.knob.setPointerCapture(ev.pointerId);
			this.dragging = true;
			this.element.classList.add('dragging');
		});
		this.knob.addEventListener('pointermove', ev => {
			if(!this.dragging) return;
			// the marker's element has no size: its corner is the antenna on the screen
			const { left, top } = this.element.getBoundingClientRect();
			const screenAngle = Math.atan2(ev.clientX - left, top - ev.clientY) * 180 / Math.PI;
			const bearing = Math.round(screenAngle + this.map.getBearing() + 720) % 360;
			this.draw(bearing);
		});
		const release = () => {
			if(!this.dragging) return;
			this.dragging = false;
			this.element.classList.remove('dragging');
			this.onTurn(this.bearing);
		};
		this.knob.addEventListener('pointerup', release);
		this.knob.addEventListener('pointercancel', release);
		// the map turned (3D view): the knob stays pointing the same way on the map
		map.on('rotate', () => { if(this.shown && !this.dragging) this.draw(this.bearing); });
		// arrow keys on the focused knob turn it too
		this.knob.addEventListener('keydown', ev => {
			const turn = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[ev.key];
			if(!turn) return;
			ev.preventDefault();
			this.draw((this.bearing + turn * (ev.shiftKey ? 15 : 1) + 360) % 360);
			this.onTurn(this.bearing);
		});
	}

	// shows the handle at an antenna ([lon, lat]) pointing at a bearing, or hides it (null)
	update(lngLat, bearing) {
		if(!lngLat) {
			if(this.shown) this.marker.remove();
			this.shown = false;
			return;
		}
		this.marker.setLngLat(lngLat);
		if(!this.shown) this.marker.addTo(this.map);
		this.shown = true;
		if(!this.dragging) this.draw(bearing);
	}

	draw(bearing) {
		this.bearing = bearing;
		const radians = (bearing - this.map.getBearing()) * Math.PI / 180;
		const dx = Math.sin(radians), dy = -Math.cos(radians);
		this.knob.style.transform = `translate(${dx * DIRECTION_ARM_LENGTH}px, ${dy * DIRECTION_ARM_LENGTH}px) translate(-50%, -50%)`;
		// beyond the knob, further out sideways where the label is wide
		const out = DIRECTION_ARM_LENGTH + 22;
		this.label.style.transform = `translate(${dx * (out + 18 * Math.abs(dx))}px, ${dy * out}px) translate(-50%, -50%)`;
		this.label.textContent = `${bearing}° ${compassPoint(bearing)}`;
	}
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
// of these nodes and of the `sources` (the nodes whose coverage is shown)
export function setLinkQuality(map, links, { labels = false, sources = [] } = {}) {
	const all = labels ? [...sources.map(node => ({ node, bars: 0 })), ...links] : links;
	const features = all.map(({ node, bars }) => {
		const { lngLat, slot, reveal } = getNodePlacement(node);
		// lower first: the coverage sites, then the best links
		const properties = { bars, label: labels, name: node.adv_name, priority: sources.includes(node) ? 0 : 4 - bars };
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
		// the coverage image's edge and direction lines
		coverageLines: emptyCollection(),
		clusterMaxZoom: clusterMaxZoomFor(DEFAULT_FILTERS.clusteringZoom),
		offsetExpression: getOffsetExpression(),
		labelOffsetExpression: getLabelOffsetExpression(),
		labelTheme: isDarkTheme() ? 'dark' : 'light',
		// names of all nodes when zoomed in close
		nodeNames: true,
		// estimated coverage images: { sites: [{ id, active, result: { url, coordinates } }], overlap }
		coverage: { sites: [], overlap: null },
	};
	// what the style being loaded / currently loaded was built with
	let applied = { ...state };
	let loaded = false;

	function apply() {
		if(!loaded) return;
		for(const source of ['nodes', 'bubbles', 'spread', 'spider', 'highlight', 'links', 'planning', 'coverageLines']) {
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
		if(applied.coverage !== state.coverage) updateCoverageImages(applied.coverage, state.coverage);
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
			if(map.getLayer(PEAKS_LAYER_ID)) map.setLayoutProperty(PEAKS_LAYER_ID, 'icon-image', peakImageExpression(state.labelTheme, map.view3d));
		}
		if(applied.nodeNames !== state.nodeNames) {
			for(const id of ['node-names', 'spread-node-names']) map.setLayoutProperty(id, 'visibility', state.nodeNames ? 'visible' : 'none');
		}
		applied = { ...state };
	}

	// images that are new or changed are added again (below all the node layers and the coverage lines),
	// the others only get their opacity changed
	function updateCoverageImages(before, now) {
		const sourceOf = id => map.getSource(id);
		const wanted = coverageImageSources(now);
		const previous = coverageImageSources(before);
		const layers = coverageImageLayers(now);
		for(const id of Object.keys(previous)) {
			if(wanted[id]?.url === previous[id].url) continue;
			if(map.getLayer(id)) map.removeLayer(id);
			if(sourceOf(id)) map.removeSource(id);
		}
		for(const layer of layers) {
			if(!sourceOf(layer.id)) {
				map.addSource(layer.id, wanted[layer.id]);
				// site images below the overlap image
				const beneath = layer.id !== OVERLAP_LAYER_ID && map.getLayer(OVERLAP_LAYER_ID) ? OVERLAP_LAYER_ID
					: map.getLayer(PEAKS_LAYER_ID) ? PEAKS_LAYER_ID : COVERAGE_LINE_LAYERS[0].id;
				map.addLayer(layer, beneath);
			} else if(layer.paint['raster-opacity'] !== undefined) {
				map.setPaintProperty(layer.id, 'raster-opacity', layer.paint['raster-opacity']);
			}
		}
	}

	map.on('style.load', () => {
		loaded = true;
		apply();
	});

	return {
		// peaks: add mountain peaks (above the coverage images)
		addTo(style, { peaks = false } = {}) {
			loaded = false;
			applied = { ...state };
			const withOverlays = {
				...style,
				sources: {
					...style.sources,
					highlight: { type: 'geojson', data: state.highlight },
					links: { type: 'geojson', data: state.links },
					planning: { type: 'geojson', data: state.planning },
					coverageLines: { type: 'geojson', data: state.coverageLines },
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
				layers: [
					...style.layers,
					...coverageImageLayers(state.coverage),
					...(peaks ? [peakLayer(state.labelTheme, map.view3d)] : []),
					...createOverlayLayers(state),
				],
			};
			if(peaks) withOverlays.sources[PEAKS_LAYER_ID] = PEAKS_SOURCE;
			Object.assign(withOverlays.sources, coverageImageSources(state.coverage));
			return withOverlays;
		},
		set(changes) {
			Object.assign(state, changes);
			apply();
		},
	};
}

// Lets the user switch the base map, expands on hover/focus
class MapTilerLogoControl {
	onAdd() {
		this.container = document.createElement('a');
		this.container.className = 'maplibregl-ctrl maptiler-logo';
		this.container.href = 'https://www.maptiler.com/';
		this.container.target = '_blank';
		this.container.rel = 'noopener';
		this.container.innerHTML = '<img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler" width="67" height="20">';
		return this.container;
	}

	setVisible(visible) {
		this.container.hidden = !visible;
	}

	onRemove() {
		this.container.remove();
	}
}

class BaseMapControl {
	// shown: { group id: boolean }; onShow(group id, shown)
	constructor(selected, onChange, shown, onShow) {
		this.selected = selected;
		this.onChange = onChange;
		this.shown = shown;
		this.onShow = onShow;
	}

	onAdd() {
		// the button stays where it is, the list opens next to it (click; a click elsewhere or Escape closes it)
		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl base-map-control';
		this.container.innerHTML = `
			<button type="button" class="base-map-button" title="Base map and layers" aria-haspopup="true" aria-expanded="false"><i>layers</i></button>
			<div class="base-map-list" role="group" aria-label="Base map and layers"></div>`;
		const button = this.container.querySelector('.base-map-button');
		const setOpen = open => {
			this.container.classList.toggle('open', open);
			button.setAttribute('aria-expanded', String(open));
		};
		button.addEventListener('click', () => setOpen(!this.container.classList.contains('open')));
		this.onOutside = ev => { if(!this.container.contains(ev.target)) setOpen(false); };
		this.onKey = ev => {
			if(ev.key !== 'Escape' || !this.container.classList.contains('open')) return;
			setOpen(false);
			button.focus();
		};
		document.addEventListener('pointerdown', this.onOutside);
		document.addEventListener('keydown', this.onKey);

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

		// parts of the map to show
		const heading = document.createElement('div');
		heading.className = 'base-map-heading';
		heading.textContent = 'Show';
		list.append(heading);
		this.checkboxes = new Map();
		for(const group of MAP_LAYER_GROUPS) {
			const label = document.createElement('label');
			label.className = 'checkbox';
			label.innerHTML = `<input type="checkbox"><span></span>`;
			label.querySelector('span').textContent = group.label;
			const input = label.querySelector('input');
			input.checked = this.shown[group.id];
			input.addEventListener('change', () => this.onShow(group.id, input.checked));
			this.checkboxes.set(group.id, { label, input });
			list.append(label);
		}

		return this.container;
	}

	// groups the current base map has (the others can't be switched: raster maps)
	setAvailable(groups) {
		for(const [id, { label, input }] of this.checkboxes) {
			input.disabled = !groups.has(id);
			label.classList.toggle('disabled', input.disabled);
			label.title = input.disabled ? 'Part of this base map\'s picture: can\'t be hidden' : '';
		}
	}

	onRemove() {
		document.removeEventListener('pointerdown', this.onOutside);
		document.removeEventListener('keydown', this.onKey);
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

// 3D view (an experiment): terrain from Mapterhorn under the map, which can then be turned and tilted
// like in Google Earth: Shift + drag or drag with the middle button (left / right turns, up / down
// tilts), Shift + arrow keys, two fingers on touch screens. Right-click stays the map menu.
const TERRAIN_3D_SOURCE = 'terrain-3d';
const TERRAIN_3D = { source: TERRAIN_3D_SOURCE, exaggeration: 1.5 };
const TERRAIN_3D_SOURCE_SPEC = {
	type: 'raster-dem',
	tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
	encoding: 'terrarium',
	tileSize: 512,
	maxzoom: 12,
	attribution: 'Elevation: <a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>',
};
// haze towards the horizon
const SKY_3D = {
	'sky-color': '#8fc1ea',
	'horizon-color': '#e4eef6',
	'fog-color': '#e4eef6',
	'sky-horizon-blend': 0.6,
	'horizon-fog-blend': 0.6,
	'fog-ground-blend': 0.7,
	'atmosphere-blend': 0.6,
};
const PITCH_3D = 60;
const MAX_PITCH_3D = 80;
// turning / tilting with the mouse: degrees per pixel
const TURN_PER_PIXEL = 0.4, TILT_PER_PIXEL = 0.3;

function read3dView() {
	try { return localStorage.getItem('view3d') === '1'; } catch { return false; }
}

// hill shading, so the relief shows (base maps without their own, except satellite imagery)
const HILLSHADE_3D = {
	id: 'hillshade-3d',
	type: 'hillshade',
	source: TERRAIN_3D_SOURCE,
	paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': 'rgba(0, 0, 0, 0.5)' },
};

// A base map style with the 3D view's terrain, sky and hill shading (under the labels)
function with3dView(style) {
	const layers = [...style.layers];
	// (satellite imagery has real shadows already)
	if(!layers.some(layer => layer.type === 'hillshade' || layer.id === 'satellite')) {
		const labels = layers.findIndex(layer => layer.type === 'symbol');
		layers.splice(labels < 0 ? layers.length : labels, 0, HILLSHADE_3D);
	}
	return {
		...style,
		sources: { ...style.sources, [TERRAIN_3D_SOURCE]: TERRAIN_3D_SOURCE_SPEC },
		layers,
		terrain: TERRAIN_3D,
		sky: SKY_3D,
	};
}

// The 3D view's camera and controls on / off (the terrain comes with the style: with3dView)
function apply3dView(map, on, { animate = true, camera = null } = {}) {
	const duration = animate ? 1000 : 0;
	if(on) {
		map.setMaxPitch(MAX_PITCH_3D);
		map.touchPitch.enable();
		map.touchZoomRotate.enableRotation();
		map.keyboard.enableRotation();
		// Shift + drag turns the map here, not a zoom box
		map.boxZoom.disable();
		map.easeTo(camera ? { pitch: camera.tilt, bearing: camera.heading, duration } : { pitch: PITCH_3D, duration });
	} else {
		map.touchPitch.disable();
		map.touchZoomRotate.disableRotation();
		map.keyboard.disableRotation();
		map.boxZoom.enable();
		map.easeTo({ pitch: 0, bearing: 0, duration });
		map.once('moveend', () => { if(!map.view3d) map.setMaxPitch(60); });
	}
}

// Shift + drag / middle button drag, as in Google Earth: right turns the view to the right, down tilts
// it towards the horizon (up looks down again)
function addTurnAndTilt(map) {
	const container = map.getContainer();
	let start = null;
	// on the map's container, while capturing: before MapLibre's own handlers (which would pan)
	container.addEventListener('mousedown', ev => {
		if(!map.view3d || !(ev.button === 1 || (ev.button === 0 && ev.shiftKey))) return;
		if(!map.getCanvas().contains(ev.target)) return;
		ev.preventDefault();
		ev.stopPropagation();
		start = { x: ev.clientX, y: ev.clientY, bearing: map.getBearing(), pitch: map.getPitch() };
		container.classList.add('map-turning');
	}, true);
	window.addEventListener('mousemove', ev => {
		if(!start) return;
		map.jumpTo({
			bearing: start.bearing + (ev.clientX - start.x) * TURN_PER_PIXEL,
			pitch: Math.max(0, Math.min(MAX_PITCH_3D, start.pitch + (ev.clientY - start.y) * TILT_PER_PIXEL)),
		});
	});
	window.addEventListener('mouseup', () => {
		if(!start) return;
		start = null;
		container.classList.remove('map-turning');
	});
}

// 3D view on / off
// The first time the 3D view is switched on: a bubble next to its button on how to turn and tilt it
// (mouse and keyboard, or touch). It goes with "Got it", once the view is turned or tilted, or with the
// 3D view; it isn't shown again.
const VIEW3D_HINT_KEY = 'view3dHintShown';

function showView3dHint(map, anchor) {
	try {
		if(localStorage.getItem(VIEW3D_HINT_KEY)) return;
		localStorage.setItem(VIEW3D_HINT_KEY, '1');
	} catch { return; }
	const touch = matchMedia('(pointer: coarse)').matches;
	const hint = document.createElement('div');
	hint.className = 'view3d-hint';
	hint.setAttribute('role', 'dialog');
	hint.setAttribute('aria-label', 'How to turn and tilt the 3D view');
	hint.innerHTML = `
		<b>Turn and tilt the 3D view</b>
		<ul>${touch ? `
			<li><i>rotate_right</i><span><b>Two fingers</b>: twist to turn</span></li>
			<li><i>swipe_vertical</i><span><b>Two fingers</b>: drag up / down to tilt</span></li>` : `
			<li><i>open_with</i><span><b>Shift + drag</b> (or the middle mouse button): left / right turns, up / down tilts</span></li>
			<li><i>keyboard</i><span><b>Shift + arrow keys</b> work too</span></li>`}
			<li><i>explore</i><span>The <b>compass</b> turns the map north up again</span></li>
		</ul>
		<button type="button" class="view3d-hint-close">Got it</button>`;
	document.body.append(hint);

	function place() {
		const box = anchor.getBoundingClientRect();
		hint.style.left = `${box.right + 12}px`;
		hint.style.top = `${Math.max(8, Math.min(box.top + box.height / 2 - hint.offsetHeight / 2, innerHeight - hint.offsetHeight - 8))}px`;
		hint.style.setProperty('--arrow-top', `${box.top + box.height / 2 - parseFloat(hint.style.top)}px`);
	}
	// once the 3D view's own tilt has eased in: the user turning or tilting it
	let watching = false;
	const startWatching = () => { if(map.getPitch() >= PITCH_3D - 1) watching = true; };
	const onTurn = () => { if(watching) close(); };
	function close() {
		hint.remove();
		removeEventListener('resize', place);
		map.off('resize', place);
		map.off('moveend', startWatching);
		map.off('rotate', onTurn);
		map.off('pitch', onTurn);
	}
	hint.querySelector('.view3d-hint-close').addEventListener('click', close);
	addEventListener('resize', place);
	map.on('resize', place);
	map.on('moveend', startWatching);
	map.on('rotate', onTurn);
	map.on('pitch', onTurn);
	place();
	return close;
}

class View3dControl {
	constructor(on, onChange) {
		this.on = on;
		this.onChange = onChange;
	}

	onAdd() {
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'maplibregl-ctrl map-button view-3d-control';
		this.button.innerHTML = '<span>3D</span>';
		this.button.addEventListener('click', () => {
			this.on = !this.on;
			this.render();
			this.onChange(this.on);
		});
		this.render();
		return this.button;
	}

	render() {
		this.button.classList.toggle('active', this.on);
		this.button.setAttribute('aria-pressed', String(this.on));
		this.button.title = this.on
			? '3D view (click for the flat map). Turn and tilt: Shift + drag, middle mouse button, Shift + arrow keys or two fingers'
			: '3D view with terrain';
	}

	onRemove() {
		this.button.remove();
	}
}

// Heading strip of the 3D view: when the map is tilted this much the compass is hard to read; a scale of
// directions at the top of the map slides with the bearing, the heading in the middle
const HEADING_MIN_PITCH = 50;
const HEADING_PX_PER_DEGREE = 3;
const HEADING_NAMES = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

function addHeadingStrip(map) {
	const strip = document.createElement('div');
	strip.className = 'heading-strip';
	strip.setAttribute('aria-hidden', 'true');
	// the scale from -360° to 720°: any heading has a full strip's width around it
	const ticks = [];
	for(let degrees = -360; degrees <= 720; degrees += 5) {
		const x = (degrees + 360) * HEADING_PX_PER_DEGREE;
		const heading = ((degrees % 360) + 360) % 360;
		const major = heading % 15 === 0;
		ticks.push(`<line x1="${x}" x2="${x}" y1="${major ? 20 : 24}" y2="28"/>`);
		if(major) {
			const name = HEADING_NAMES[heading];
			ticks.push(`<text x="${x}" y="14" class="${name ? 'heading-name' : ''}${heading === 0 ? ' heading-north' : ''}">${name ?? heading}</text>`);
		}
	}
	strip.innerHTML = `<svg class="heading-tape" width="${1080 * HEADING_PX_PER_DEGREE}" height="28">${ticks.join('')}</svg>
		<span class="heading-marker"></span><span class="heading-value"></span>`;
	map.getContainer().append(strip);
	const tape = strip.querySelector('.heading-tape');
	const value = strip.querySelector('.heading-value');
	function render() {
		const shown = !!map.view3d && map.getPitch() >= HEADING_MIN_PITCH;
		strip.classList.toggle('shown', shown);
		if(!shown) return;
		const heading = ((map.getBearing() % 360) + 360) % 360;
		tape.style.transform = `translateX(${strip.clientWidth / 2 - (heading + 360) * HEADING_PX_PER_DEGREE}px)`;
		value.textContent = `${Math.round(heading) % 360}° ${compassPoint(heading)}`;
	}
	map.on('rotate', render);
	map.on('pitch', render);
	map.on('resize', render);
	map.on('style.load', render);
	render();
}

// the compass's cylinder: rings below its face, this far apart (px)
const COMPASS_DEPTH = 5, COMPASS_RING_STEP = 0.5;

// Compass of the 3D view: points north, a click turns the map north up again
class CompassControl {
	onAdd(map) {
		this.map = map;
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'maplibregl-ctrl map-button compass-control';
		this.button.title = 'North up';
		this.button.setAttribute('aria-label', 'Turn the map north up');
		// a compass on a short cylinder (stacked rings below its face), tilted like the map and turned
		// with it: the dial's ticks, a red north mark and the needle (red half to the north)
		const ticks = Array.from({ length: 16 }, (_, i) => {
			const long = i % 4 === 0;
			return `<line x1="16" y1="${long ? 2.6 : 3.2}" x2="16" y2="${long ? 6 : 4.8}" transform="rotate(${i * 22.5} 16 16)"/>`;
		}).join('');
		this.button.innerHTML = `<span class="compass-scene" aria-hidden="true"><span class="compass-dial">
			${Array.from({ length: COMPASS_DEPTH }, (_, i) => `<span class="compass-wall" style="transform: translateZ(${-(i + 1) * COMPASS_RING_STEP}px)"></span>`).join('')}
			<svg class="compass-face" viewBox="0 0 32 32">
				<circle class="compass-rim" cx="16" cy="16" r="15"/>
				<g class="compass-ticks">${ticks}</g>
				<path class="compass-north" d="M16 0.8 L18.4 4.6 L13.6 4.6 Z"/>
				<path d="M16 7 L19 16 L13 16 Z" fill="#d32f2f"/><path d="M16 25 L19 16 L13 16 Z" class="compass-south"/>
				<circle cx="16" cy="16" r="1.3" class="compass-pin"/>
			</svg>
		</span></span>`;
		this.button.addEventListener('click', () => map.easeTo({ bearing: 0, duration: 500 }));
		this.render = () => {
			this.button.querySelector('.compass-dial').style.transform = `rotateX(${map.getPitch()}deg) rotateZ(${-map.getBearing()}deg)`;
		};
		map.on('rotate', this.render);
		map.on('pitch', this.render);
		this.render();
		return this.button;
	}

	setVisible(visible) {
		this.button.hidden = !visible;
	}

	onRemove() {
		this.map.off('rotate', this.render);
		this.map.off('pitch', this.render);
		this.button.remove();
	}
}

// camera3d: the 3D view's { tilt, heading } from a link (opens the 3D view) or null
export function createMap(elementId, { lat, lon, zoom, camera3d = null }) {
	let baseMap = readBaseMapSelection();
	if(camera3d) {
		try { localStorage.setItem('view3d', '1'); } catch {}
	}
	const view3d = !!camera3d || read3dView();

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
		maxPitch: view3d ? MAX_PITCH_3D : 60,
	});
	map.view3d = view3d;
	addTurnAndTilt(map);
	// parts of the map shown / hidden (MAP_LAYER_GROUPS), and the layers the base map itself hides
	const shownMapLayers = readShownMapLayers();
	let hiddenByStyle = new Set();
	function applyShownMapLayers(style) {
		hiddenByStyle = new Set(style.layers.filter(layer => layer.layout?.visibility === 'none').map(layer => layer.id));
		return {
			...style,
			layers: style.layers.map(layer => {
				const group = mapLayerGroup(layer);
				return group && !shownMapLayers[group] ? { ...layer, layout: { ...layer.layout, visibility: 'none' } } : layer;
			}),
		};
	}
	function showMapLayers(groupId, shown) {
		shownMapLayers[groupId] = shown;
		try { localStorage.setItem('mapLayers', JSON.stringify(shownMapLayers)); } catch {}
		for(const layer of map.getStyle()?.layers ?? []) {
			if(mapLayerGroup(layer) !== groupId || hiddenByStyle.has(layer.id)) continue;
			map.setLayoutProperty(layer.id, 'visibility', shown ? 'visible' : 'none');
		}
	}
	map.touchZoomRotate.disableRotation();
	map.keyboard.disableRotation();
	map.setMissingStyleImageResolver(id => resolveImage(map, id));
	// MapLibre logs map errors only while nothing listens to them: everything is still logged, except
	// Mapterhorn's 404s over open sea (it has no tiles there; OpenTopoMap's relief and contours ask anyway)
	map.on('error', ({ error }) => {
		if(/\b404\b.*tiles\.mapterhorn\.com/.test(String(error?.message ?? error))) return;
		console.error(error);
	});

	const overlays = createOverlays(map);
	map.overlays = overlays;
	// the coverage lines' dashes are screen pixels long: cut again for the new view
	map.on('moveend', () => {
		if(map.coverageLineShapes?.length) overlays.set({ coverageLines: dashCoverageLines(map) });
	});

	let baseMapRequest = 0;
	async function loadBaseMap() {
		const request = ++baseMapRequest;
		let style;
		try {
			style = await BASE_MAPS[baseMap]();
		} catch(error) {
			console.error(`Base map ${baseMap} could not be loaded`, error);
			return;
		}
		// another base map was picked in the meantime
		if(request !== baseMapRequest) return;
		applyBaseMapLimits(map, BASE_MAP_BOUNDS[baseMap] ?? null, BASE_MAP_HOME[baseMap]);
		map.setStyle(style, {
			diff: false,
			transformStyle: (previous, next) => applyShownMapLayers(overlays.addTo(map.view3d ? with3dView(next) : next, {
				peaks: !BASE_MAPS_WITH_PEAKS.has(baseMap) && !next.layers.some(layer => layer['source-layer'] === 'mountain_peak'),
			})),
		});
	}

	// added first, so it ends up at the bottom of the corner
	const mapTilerLogo = new MapTilerLogoControl();
	map.addControl(mapTilerLogo, 'bottom-left');
	mapTilerLogo.setVisible(MAPTILER_BASE_MAPS.has(baseMap));
	const baseMapControl = new BaseMapControl(baseMap, name => {
		baseMap = name;
		try { localStorage.setItem('baseMapSelected', name); } catch {}
		mapTilerLogo.setVisible(MAPTILER_BASE_MAPS.has(name));
		loadBaseMap();
	}, shownMapLayers, showMapLayers);
	map.addControl(baseMapControl, 'bottom-left');
	map.on('style.load', () => {
		baseMapControl.setAvailable(new Set(map.getStyle().layers.map(mapLayerGroup).filter(Boolean)));
	});
	// bottom corners stack upwards, so this one ends up above the base map switcher
	map.addControl(new ThemeControl(), 'bottom-left');
	let closeView3dHint = null;
	const view3dControl = new View3dControl(map.view3d, on => {
		closeView3dHint?.();
		closeView3dHint = on ? showView3dHint(map, view3dControl.button) : null;
		map.view3d = on;
		try { localStorage.setItem('view3d', on ? '1' : '0'); } catch {}
		compass.setVisible(on);
		// the style again, with / without the terrain; then the tilt (a new style stops camera animations)
		loadBaseMap();
		map.once('style.load', () => { if(map.view3d === on) apply3dView(map, on); });
	});
	map.addControl(view3dControl, 'bottom-left');
	const compass = new CompassControl();
	map.addControl(compass, 'bottom-left');
	compass.setVisible(map.view3d);
	// no symbols beyond the 3D view's horizon (in the sky and the fog)
	addHorizonCutoff(map);
	// the heading when the map is tilted too much to read the compass
	addHeadingStrip(map);
	// a 3D view from last time (the terrain comes with the style)
	if(map.view3d) apply3dView(map, true, { animate: false, camera: camera3d && { tilt: Math.max(0, Math.min(MAX_PITCH_3D, camera3d.tilt)), heading: camera3d.heading } });

	// on narrow screens MapLibre shows the compact attribution expanded until the first drag,
	// covering the map buttons - start collapsed (the ⓘ button still expands it)
	map.once('load', () => {
		const attribution = map.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show');
		attribution?.classList.remove('maplibregl-compact-show');
		attribution?.removeAttribute('open');
	});

	onThemeChange(dark => {
		overlays.set({ labelTheme: dark ? 'dark' : 'light' });
		if(THEMED_BASE_MAPS.has(baseMap)) loadBaseMap();
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
	} else if(kind === 'peak') {
		const [theme, stick, ele, ...name] = arg.split('|');
		canvas = drawPeak(name.join('|'), ele, theme, stick === '1');
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

// Mountain peak: name and height over a small triangle (on a stick in the 3D view); its bottom
// centre is on the summit
function drawPeak(name, ele, theme, stick) {
	const font = 'italic 600 11.5px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
	const halo = 3, lineHeight = 14, triangle = 6;
	const height = Number(ele) > 0 ? `${ele} m` : '';
	const measure = document.createElement('canvas').getContext('2d');
	measure.font = font;
	const width = Math.ceil(Math.max(measure.measureText(name).width, measure.measureText(height).width)) + halo * 2 + 2;
	const textHeight = lineHeight * (height ? 2 : 1) + 2;
	const total = textHeight + triangle + (stick ? PEAK_STICK_HEIGHT : 0);

	const [canvas, ctx] = createCanvas(width, total);
	const { text: color, halo: haloColor } = PEAK_STYLES[theme] ?? PEAK_STYLES.light;
	const x = width / 2;
	ctx.font = font;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.lineJoin = 'round';
	ctx.lineWidth = halo;
	ctx.strokeStyle = haloColor;
	ctx.fillStyle = color;
	[name, height].filter(Boolean).forEach((line, i) => {
		const y = lineHeight * (i + 0.5) + 1;
		ctx.strokeText(line, x, y);
		ctx.fillText(line, x, y);
	});
	// triangle (and stick) with a thin halo
	const top = textHeight;
	ctx.beginPath();
	ctx.moveTo(x, top);
	ctx.lineTo(x + triangle * 0.6, top + triangle);
	ctx.lineTo(x - triangle * 0.6, top + triangle);
	ctx.closePath();
	ctx.lineWidth = 2;
	ctx.stroke();
	ctx.fill();
	if(stick) {
		ctx.fillStyle = haloColor;
		ctx.fillRect(x - 1.5, top + triangle, 3, PEAK_STICK_HEIGHT);
		ctx.fillStyle = color;
		ctx.fillRect(x - 0.5, top + triangle, 1, PEAK_STICK_HEIGHT);
	}
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

// Topmost node, group or cluster at the point; the layers are missing while a new base style loads,
// and there's no style at all while the first one is fetched (OpenTopoMap's comes in later)
function queryTopFeature(map, point) {
	if(!map.style || !map.getLayer('nodes')) return null;
	// a coverage site's mark is on top: a click on it selects the site (see app.js), not a node below
	const marks = map.getLayer('planning-points') ? map.queryRenderedFeatures(point, { layers: ['planning-points'] }) : [];
	if(marks.some(mark => mark.properties.site !== undefined && mark.properties.site !== null)) return null;
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

// The part of the screen a popup may use (viewport coordinates): not cut off by the screen edges
// nor covered by the overlays at the top (the docked panels are beside the map, not over it)
function getPopupArea(map) {
	const margin = 10;
	const mapBox = map.getContainer().getBoundingClientRect();
	return {
		top: Math.max(mapBox.top, getTopOverlayBottom()) + margin,
		// room for the attribution bar
		bottom: Math.min(mapBox.bottom, innerHeight) - 30,
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
