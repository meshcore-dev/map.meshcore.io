export const NODES_API_URL = 'https://map.meshcore.io/api/v1/nodes?binary=1&short=1';
export const PRESETS_API_URL = 'https://api.meshcore.nz/api/v1/config';
// MapTiler base maps (public key, only accepted from the site's domain: maps fail with HTTP 403 locally)
export const MAPTILER_KEY = 'rW6swAgiEVwSUhHzOHRQ';
// deletion requests are processed automatically by this recipient address (Gmail plus-addressing),
// so the +tag has to survive; the subject is only a pre-filled courtesy
export const DELETION_EMAIL = 'recrof+meshcore-map-delete@gmail.com';
export const DELETION_SUBJECT = 'MeshCore Map node deletion request';
export const DELETION_MAX_NODES = 8;
// keys sent in a deletion request are remembered (and left out of new requests) for this long
export const DELETION_REQUESTED_REMEMBER_DAYS = 30;

export const DEFAULT_VIEW = { lat: 7, lon: 25, zoom: 3 };

export const DEFAULT_FILTERS = {
	nodeFilter: [1, 2, 3, 4],
	freqFilter: [],
	fromDate: '2025-03-01',
	fromInsertDate: '2025-03-01',
	clusteringZoom: 12,
	presetIndex: 0,
	onlyDuplicates: false,
};

export const NODE_TYPES = {
	1: 'Client',
	2: 'Repeater',
	3: 'Room Server',
	4: 'Sensor',
};

// Age thresholds (days since last update) for the marker freshness colour
export const STATUS_THRESHOLD_DAYS = {
	stale: 5,
	old: 10,
	extinct: 20,
};

export const UPDATE_STATUS_DESC = {
	none: 'manually added',
	recent: 'updated recently',
	stale: 'updated while ago',
	old: 'not updated',
	extinct: 'will be deleted soon',
};

export const RADIO_PARAM_DESC = {
	bw: { label: 'Bandwidth', unit: 'kHz' },
	freq: { label: 'Frequency', unit: 'MHz' },
	sf: { label: 'Spreading factor', unit: '' },
	cr: { label: 'Coding rate', unit: '' },
};

// Short keys used by the binary API, mapped to full node property names
export const NODE_KEYS = {
	pk: 'public_key',
	t: 'type',
	n: 'adv_name',
	la: 'last_advert',
	id: 'inserted_date',
	ud: 'updated_date',
	p: 'params',
	l: 'link',
	s: 'source',
};

export const SEARCH_RESULT_LIMIT = 20;
// highest zoom supported by all base maps (Esri Satellite stops at 18)
export const NODE_FOCUS_ZOOM = 18;
// flyTo duration scales with distance (8s+ across continents) - cap it
export const NODE_FLY_DURATION_SECONDS = 1;
export const NODE_PROCESSING_CHUNK_SIZE = 2000;
