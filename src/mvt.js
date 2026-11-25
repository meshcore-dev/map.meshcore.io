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
			// multiplication instead of bit shifts keeps numbers above 2^31 right
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

// Value message: string (1), float (2), double (3), int64 (4), uint64 (5), sint64 (6), bool (7)
function readValue(bytes) {
	const reader = new Reader(bytes);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let value = null;
	while(reader.pos < bytes.length) {
		const [field, type] = reader.tag();
		if(field === 1) value = textDecoder.decode(reader.bytesField());
		else if(field === 2 && type === 5) { value = view.getFloat32(reader.pos, true); reader.pos += 4; }
		else if(field === 3 && type === 1) { value = view.getFloat64(reader.pos, true); reader.pos += 8; }
		else if(field === 4 || field === 5) value = reader.varint();
		else if(field === 6) { const n = reader.varint(); value = n % 2 ? -(n + 1) / 2 : n / 2; }
		else if(field === 7) value = reader.varint() !== 0;
		else reader.skip(type);
	}
	return value;
}

// Polygon rings of the features in `layerName` that pass `filter(properties)`.
// Returns { extent, rings: [[x0, y0, x1, y1, ...], ...] } in tile coordinates; holes wind the other
// way, so filling with the nonzero rule leaves them out.
export function readPolygons(buffer, layerName, filter) {
	const rings = [];
	const extent = readLayerOf(buffer, layerName, filter, (properties, featureRings) => rings.push(...featureRings));
	return { extent, rings };
}

// Polygon features of `layerName` that pass `filter(properties)`, each with its own rings:
// { extent, features: [{ properties, rings }, ...] }
export function readPolygonFeatures(buffer, layerName, filter) {
	const features = [];
	const extent = readLayerOf(buffer, layerName, filter, (properties, rings) => features.push({ properties, rings }));
	return { extent, features };
}

// Calls onFeature(properties, rings) for the layer's polygons; returns the layer's extent
function readLayerOf(buffer, layerName, filter, onFeature) {
	const tile = new Reader(new Uint8Array(buffer));
	while(tile.pos < tile.bytes.length) {
		const [field, type] = tile.tag();
		if(field !== 3) {
			tile.skip(type);
			continue;
		}
		const extent = readLayer(tile.bytesField(), layerName, filter, onFeature);
		if(extent !== null) return extent;
	}
	return 4096;
}

function readLayer(bytes, layerName, filter, onFeature) {
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
		const rings = [];
		decodeRings(geometry, rings);
		onFeature(properties, rings);
	}
	return extent;
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
