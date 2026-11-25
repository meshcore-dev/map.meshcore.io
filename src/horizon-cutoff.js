// The 3D view's horizon: the map ends some way before the real horizon (sky above) and the far terrain is
// in fog - but symbols (nodes, clusters, peaks, place names) would be drawn over both. In the 3D view,
// those layers only show what's on the ground in front of the fog: a filter (within a polygon) that
// follows the camera, updated a few times a second while it moves and once it stops. Whole symbols
// go, none is cut in half.
//
// Where the fog starts: the map's edge is where MapLibre's camera says the map surface ends (geometry
// only, not the terrain as drawn - that changes while it loads). The fog covers about the same share of
// the way from the edge down to the centre at any zoom and tilt.

// our layers with symbols (map.js) and the peaks
const LAYER_IDS = ['highlight', 'clusters', 'spider-legs', 'spider-centers', 'nodes', 'groups', 'spread-nodes',
	'node-names', 'spread-node-names', 'node-labels', 'link-quality', 'peaks'];
// and the base map's place names and peaks
const BASE_SOURCE_LAYERS = new Set(['place', 'place_labels', 'mountain_peak']);
// share of the way from the map's edge down to the centre where symbols stop
// (the flat map ends well before the horizon, in fog; the globe's edge is its horizon)
const CUTOFF_SHARE = { flat: 0.2, globe: 0.04 };
const UPDATE_INTERVAL_MS = 250;

// The flat map ends at 85 % of the way to the horizon (as MapLibre draws it)
function flatMapEdge(map, height) {
	const radians = degrees => degrees * Math.PI / 180;
	const { top, bottom } = map.getPadding();
	const toCenter = height / 2 / Math.tan(radians(map.getVerticalFieldOfView()) / 2);
	const pitch = map.getPitch();
	return top + (height - top - bottom) / 2 - toCenter * Math.min(Math.tan(radians(90 - pitch)) * 0.85, Math.tan(radians(89.25 - pitch)));
}

// The highest screen row (px) on the map, -1 when the map reaches the top of the screen
function findMapEdge(map, transform, x, height) {
	// MapLibre's own test (internal; without it: the flat map's edge, from the tilt and field of view)
	const onMap = typeof transform?.isPointOnMapSurface === 'function'
		? y => transform.isPointOnMapSurface({ x, y })
		: y => y > flatMapEdge(map, height);
	if(onMap(0)) return -1;
	let above = 0, below = height - 1;
	if(!onMap(below)) return null;
	while(below - above > 1) {
		const middle = (above + below) >> 1;
		if(onMap(middle)) below = middle;
		else above = middle;
	}
	return below;
}

// The ground in front of the fog: a polygon ([[lon, lat], ...] closed) from the cutoff row down past the
// bottom of the screen, wider than the screen; null when there's no fog on the screen
function getVisibleGround(map) {
	const canvas = map.getCanvas();
	const width = canvas.clientWidth, height = canvas.clientHeight;
	const transform = map._camera?.transform;
	const edge = findMapEdge(map, transform, width / 2, height);
	if(edge === null || edge < 0) return null;
	const share = CUTOFF_SHARE[map.getProjection()?.type === 'globe' ? 'globe' : 'flat'];
	const cutoff = edge + Math.max(0, height / 2 - edge) * share;
	// on the plain surface (the drawn terrain would make it jump)
	const toLngLat = (x, y) => {
		const lngLat = typeof transform?.screenPointToLocation === 'function'
			? transform.screenPointToLocation({ x, y })
			: map.unproject([x, y]);
		return [lngLat.lng, lngLat.lat];
	};
	const corners = [
		toLngLat(-0.25 * width, cutoff), toLngLat(1.25 * width, cutoff),
		toLngLat(1.25 * width, height + 100), toLngLat(-0.25 * width, height + 100),
	];
	if(corners.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat))) return null;
	return [...corners, corners[0]];
}

export function addHorizonCutoff(map) {
	// the layers' own filters (per style), by layer id
	let originals = new Map();
	let applied = null;
	let lastUpdate = 0, timer = null;

	function layerIds() {
		const ids = LAYER_IDS.filter(id => map.getLayer(id));
		for(const layer of map.getStyle()?.layers ?? []) {
			if(layer.type === 'symbol' && BASE_SOURCE_LAYERS.has(layer['source-layer']) && !ids.includes(layer.id)) ids.push(layer.id);
		}
		return ids;
	}
	function setFilters(polygon) {
		const key = polygon ? JSON.stringify(polygon.map(([lon, lat]) => [lon.toFixed(4), lat.toFixed(4)])) : null;
		if(key === applied) return;
		applied = key;
		for(const id of layerIds()) {
			if(!originals.has(id)) originals.set(id, map.getFilter(id) ?? null);
			const original = originals.get(id);
			const within = polygon && ['within', { type: 'Polygon', coordinates: [polygon] }];
			map.setFilter(id, !within ? original : original ? ['all', original, within] : within, { validate: false });
		}
	}
	function update() {
		lastUpdate = performance.now();
		timer = null;
		if(!map.style?._loaded) return;
		setFilters(map.view3d ? getVisibleGround(map) : null);
	}
	// a few times a second while the camera moves
	function scheduleUpdate() {
		if(timer) return;
		timer = setTimeout(update, Math.max(0, UPDATE_INTERVAL_MS - (performance.now() - lastUpdate)));
	}

	map.on('style.load', () => {
		originals = new Map();
		applied = null;
		update();
	});
	map.on('move', scheduleUpdate);
	map.on('moveend', () => {
		clearTimeout(timer);
		update();
	});
	return update;
}
