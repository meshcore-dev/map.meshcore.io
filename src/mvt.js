// Minimal Mapbox Vector Tile (MVT) reader: just enough to get polygons of one layer out of a tile
// (protobuf wire format, https://github.com/mapbox/vector-tile-spec)

class Reader {
	constructor(bytes) {
		this.bytes = bytes;
		this.pos = 0;
	}

	varint() {
		let result = 0, shift = 0, byte;
		do {
			byte = this.bytes[this.pos++];
			// numbers above 2^31 only show up in fields we skip; keep the arithmetic safe anyway
			result += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while(byte & 0x80);
		return result;
	}

	// [field number, wire type] of the next field
	tag() {
		const tag = this.varint();
		return [Math.floor(tag / 8), tag & 7];
	}

	bytesField() {
		const length = this.varint();
		const start = this.pos;
		this.pos += length;
		return this.bytes.subarray(start, this.pos);
	}

	skip(type) {
		if(type === 0) this.varint();
		else if(type === 1) this.pos += 8;
		else if(type === 2) this.pos += this.varint();
		else if(type === 5) this.pos += 4;
		else throw new Error(`MVT: unsupported wire type ${type}`);
	}

	packed() {
		const end = this.varint() + this.pos;
		const values = [];
		while(this.pos < end) values.push(this.varint());
		return values;
	}
}

const textDecoder = new TextDecoder();

function readValue(bytes) {
	const reader = new Reader(bytes);
	let value = null;
	while(reader.pos < bytes.length) {
		const [field, type] = reader.tag();
		if(field === 1) value = textDecoder.decode(reader.bytesField());
		// numbers and booleans aren't needed here
		else reader.skip(type);
	}
	return value;
}

// Polygon rings of the features in `layerName` that pass `filter(properties)` (string properties only).
// Returns { extent, rings: [[x0, y0, x1, y1, ...], ...] } in tile coordinates; holes wind the other
// way, so filling with the nonzero rule leaves them out.
export function readPolygons(buffer, layerName, filter) {
	const tile = new Reader(new Uint8Array(buffer));
	while(tile.pos < tile.bytes.length) {
		const [field, type] = tile.tag();
		if(field !== 3) {
			tile.skip(type);
			continue;
		}
		const layer = readLayer(tile.bytesField(), layerName, filter);
		if(layer) return layer;
	}
	return { extent: 4096, rings: [] };
}

function readLayer(bytes, layerName, filter) {
	const reader = new Reader(bytes);
	let name = null, extent = 4096;
	const keys = [], values = [], features = [];
	while(reader.pos < bytes.length) {
		const [field, type] = reader.tag();
		if(field === 1) {
			name = textDecoder.decode(reader.bytesField());
			// the name comes first: skip other layers without decoding them
			if(name !== layerName) return null;
		}
		else if(field === 2) features.push(reader.bytesField());
		else if(field === 3) keys.push(textDecoder.decode(reader.bytesField()));
		else if(field === 4) values.push(readValue(reader.bytesField()));
		else if(field === 5) extent = reader.varint();
		else reader.skip(type);
	}
	if(name !== layerName) return null;

	const rings = [];
	for(const featureBytes of features) {
		const feature = new Reader(featureBytes);
		let tags = [], geometryType = 0, geometry = null;
		while(feature.pos < featureBytes.length) {
			const [field, type] = feature.tag();
			if(field === 2) tags = feature.packed();
			else if(field === 3) geometryType = feature.varint();
			else if(field === 4) geometry = feature.packed();
			else feature.skip(type);
		}
		// polygons only
		if(geometryType !== 3 || !geometry) continue;
		const properties = {};
		for(let i = 0; i + 1 < tags.length; i += 2) properties[keys[tags[i]]] = values[tags[i + 1]];
		if(!filter(properties)) continue;
		decodeRings(geometry, rings);
	}
	return { extent, rings };
}

// Geometry commands: MoveTo (1), LineTo (2), ClosePath (7); coordinates are zigzag deltas
function decodeRings(geometry, rings) {
	let x = 0, y = 0, ring = null;
	for(let i = 0; i < geometry.length;) {
		const command = geometry[i] & 7;
		const count = geometry[i++] >> 3;
		if(command === 7) {
			if(ring?.length >= 6) rings.push(ring);
			ring = null;
			continue;
		}
		for(let j = 0; j < count; j++) {
			const dx = geometry[i++], dy = geometry[i++];
			x += (dx >> 1) ^ -(dx & 1);
			y += (dy >> 1) ^ -(dy & 1);
			if(command === 1) {
				if(ring?.length >= 6) rings.push(ring);
				ring = [];
			}
			ring.push(x, y);
		}
	}
	if(ring?.length >= 6) rings.push(ring);
}
