import { ProgramCache, bindAttributes, keepLayer, mercator, setProjection, tileAround } from './webgl-layer.js';

// The point-to-point profile in the 3D view: the line of sight between the antenna tops through the air,
// the first Fresnel zone as a see-through tube around it (blue where it's clear, amber where the
// terrain, trees or buildings get into it, red where they block the line of sight), a faint curtain
// from the line down to the ground (shows how high above the valley the line is), the antenna masts
// and the spot hovered in the chart. The terrain hides what's behind or inside it, so a ridge pokes
// through the tube where it's in the way.
//
// A MapLibre custom WebGL layer (webgl-layer.js). Heights are scaled like the terrain (its exaggeration). The earth's bulge, which the chart adds to the terrain,
// is taken off the line instead: the map's terrain has none.

const LAYER_ID = 'profile-3d';
// drawn under these (the profile's end marks)
const BEFORE_LAYER_ID = 'planning-hover';
const MAX_RINGS = 200;
const RING_SEGMENTS = 28;
const FRESNEL_CLEAR = 0.6;
const COLORS = {
	clear: [0.12, 0.53, 0.9],
	fresnel: [0.98, 0.66, 0.15],
	blocked: [0.9, 0.22, 0.21],
	mast: [0.2, 0.2, 0.22],
	hover: [1, 1, 1],
};
const TUBE_ALPHA = 0.3;
// the curtain fades from the line down to the ground
const CURTAIN_ALPHA = [0.22, 0.03];
const LINE_WIDTH = 3;
const MAST_WIDTH = 2;

// screen-space wide lines: each vertex knows the other end of its segment and its side (-1, 1)
const LINE_VERTEX = `
	uniform vec2 u_viewport;
	uniform float u_width;
	in vec3 a_pos;
	in vec3 a_other;
	in float a_side;
	in vec4 a_color;
	out vec4 v_color;
	void main() {
		vec4 p = projectTileFor3D(a_pos.xy, a_pos.z);
		vec4 o = projectTileFor3D(a_other.xy, a_other.z);
		vec2 dir = normalize((o.xy / o.w - p.xy / p.w) * u_viewport);
		vec2 normal = vec2(-dir.y, dir.x);
		p.xy += normal * a_side * u_width / u_viewport * p.w;
		gl_Position = p;
		v_color = a_color;
	}`;
const TUBE_VERTEX = `
	in vec3 a_pos;
	in vec4 a_color;
	out vec4 v_color;
	void main() {
		gl_Position = projectTileFor3D(a_pos.xy, a_pos.z);
		v_color = a_color;
	}`;
const clearanceColor = ratio => ratio >= FRESNEL_CLEAR ? COLORS.clear : ratio >= 0 ? COLORS.fresnel : COLORS.blocked;

// Geometry from the profile and the terrain exaggeration: the tile it's in ({ z, x, y }), the tube
// (x, y, z, r, g, b, a per vertex, with triangle indices) and the lines (x, y, z, other x, y, z, side,
// r, g, b, a per vertex, 4 vertices a segment, with each segment's width)
function buildGeometry({ a, b, samples, hover }, exaggeration) {
	const start = mercator(a), end = mercator(b);
	// a tile about as big as the path
	const { tile, toTile, unitAt } = tileAround(start, end);
	const unit = unitAt(start);

	const [ax, ay] = toTile(start.x, start.y);
	const [bx, by] = toTile(end.x, end.y);
	const dx = bx - ax, dy = by - ay;
	const length = Math.hypot(dx, dy) || 1;
	// horizontal, across the path
	const nx = -dy / length, ny = dx / length;
	const last = samples.length - 1;
	const distance = samples[last].x || 1;
	const at = s => [ax + dx * s.x / distance, ay + dy * s.x / distance];
	const height = s => (s.los - s.bulge) * exaggeration;
	const groundHeight = s => (s.ground - s.bulge) * exaggeration;

	// rings at every step-th sample; each takes the worst clearance of the samples around it
	const step = Math.max(1, Math.ceil(last / MAX_RINGS));
	const rings = [];
	for(let i = 0; i <= last; i += step) rings.push(i);
	if(rings.at(-1) !== last) rings.push(last);
	const worst = rings.map((i, r) => {
		const to = rings[r + 1] ?? last;
		let ratio = Infinity;
		for(let j = i; j <= to; j++) {
			const s = samples[j];
			if(s.fresnel > 0) ratio = Math.min(ratio, (s.los - s.top) / s.fresnel);
			else if(s.top > s.los) ratio = Math.min(ratio, -1);
		}
		return ratio;
	});

	// the tube: rings of RING_SEGMENTS + 1 vertices, lit from above
	const tube = [];
	rings.forEach((i, r) => {
		const s = samples[i];
		const [cx, cy] = at(s);
		const cz = height(s);
		const color = clearanceColor(worst[r]);
		for(let k = 0; k <= RING_SEGMENTS; k++) {
			const angle = 2 * Math.PI * k / RING_SEGMENTS;
			const across = Math.cos(angle) * s.fresnel * unit;
			const light = 0.8 + 0.35 * Math.sin(angle);
			tube.push(cx + nx * across, cy + ny * across, cz + Math.sin(angle) * s.fresnel * exaggeration,
				color[0] * light, color[1] * light, color[2] * light, TUBE_ALPHA);
		}
	});
	const indices = [];
	const row = RING_SEGMENTS + 1;
	for(let r = 0; r < rings.length - 1; r++) {
		for(let k = 0; k < RING_SEGMENTS; k++) {
			const p = r * row + k, q = p + row;
			indices.push(p, q, p + 1, p + 1, q, q + 1);
		}
	}
	// the curtain: a pair of vertices (at the line, on the ground) at each ring
	const curtainStart = tube.length / 7;
	rings.forEach((i, r) => {
		const s = samples[i];
		const [cx, cy] = at(s);
		const color = clearanceColor(worst[r]);
		tube.push(cx, cy, height(s), ...color, CURTAIN_ALPHA[0]);
		tube.push(cx, cy, Math.min(height(s), groundHeight(s)), ...color, CURTAIN_ALPHA[1]);
	});
	for(let r = 0; r < rings.length - 1; r++) {
		const p = curtainStart + r * 2;
		indices.push(p, p + 1, p + 2, p + 2, p + 1, p + 3);
	}

	// lines: the line of sight (red where it's blocked), the masts, the hovered spot
	const lines = { data: [], widths: [] };
	const segment = (from, to, color, width) => {
		for(const [p, o, side] of [[from, to, 1], [from, to, -1], [to, from, -1], [to, from, 1]]) {
			lines.data.push(...p, ...o, side, ...color, 1);
		}
		lines.widths.push(width);
	};
	for(let r = 0; r < rings.length - 1; r++) {
		const s = samples[rings[r]], t = samples[rings[r + 1]];
		segment([...at(s), height(s)], [...at(t), height(t)], worst[r] < 0 ? COLORS.blocked : COLORS.clear, LINE_WIDTH);
	}
	for(const s of [samples[0], samples[last]]) {
		if(s.los - s.ground > 0.5) segment([...at(s), groundHeight(s)], [...at(s), height(s)], COLORS.mast, MAST_WIDTH);
	}
	if(hover !== null && samples[hover]) {
		const s = samples[hover];
		segment([...at(s), groundHeight(s)], [...at(s), height(s) + s.fresnel * exaggeration], COLORS.hover, MAST_WIDTH);
	}
	return { tile, tube: new Float32Array(tube), indices: new Uint16Array(indices), lines: { data: new Float32Array(lines.data), widths: lines.widths } };
}

class Profile3dLayer {
	constructor() {
		this.id = LAYER_ID;
		this.type = 'custom';
		this.renderingMode = '3d';
		this.profile = null;
		this.geometry = null;
		this.programs = new ProgramCache({ line: LINE_VERTEX, tube: TUBE_VERTEX });
	}
	setProfile(profile) {
		this.profile = profile;
		this.geometry = null;
	}
	onAdd(map, gl) {
		this.map = map;
		this.buffers = { tube: gl.createBuffer(), indices: gl.createBuffer(), lines: gl.createBuffer() };
		this.uploaded = null;
	}
	onRemove(map, gl) {
		for(const buffer of Object.values(this.buffers)) gl.deleteBuffer(buffer);
		this.programs.delete(gl);
	}
	upload(gl) {
		const exaggeration = this.map.getTerrain()?.exaggeration ?? 1;
		if(!this.geometry || exaggeration !== this.geometry.exaggeration) {
			this.geometry = { ...buildGeometry(this.profile, exaggeration), exaggeration };
		}
		if(this.uploaded === this.geometry) return;
		const { tube, indices, lines } = this.geometry;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.tube);
		gl.bufferData(gl.ARRAY_BUFFER, tube, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.lines);
		gl.bufferData(gl.ARRAY_BUFFER, lines.data, gl.STATIC_DRAW);
		this.uploaded = this.geometry;
	}
	render(gl, args) {
		if(!this.profile) return;
		// the index buffer binding belongs to the bound vertex array: not one of MapLibre's
		gl.bindVertexArray(null);
		this.upload(gl);
		const { tile, indices, lines } = this.geometry;
		const programs = this.programs.get(gl, args.shaderData);

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.disable(gl.CULL_FACE);

		// the line and the masts first (they write depth), then the see-through tube over them
		gl.depthMask(true);
		gl.useProgram(programs.line);
		setProjection(gl, programs.line, args, tile);
		gl.uniform2f(gl.getUniformLocation(programs.line, 'u_viewport'), gl.drawingBufferWidth / 2, gl.drawingBufferHeight / 2);
		const widthLocation = gl.getUniformLocation(programs.line, 'u_width');
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.lines);
		let release = bindAttributes(gl, programs.line, [['a_pos', 3, 0], ['a_other', 3, 3], ['a_side', 1, 6], ['a_color', 4, 7]], 11);
		const pixelRatio = devicePixelRatio || 1;
		lines.widths.forEach((width, i) => {
			gl.uniform1f(widthLocation, width * pixelRatio / 2);
			gl.drawArrays(gl.TRIANGLE_STRIP, i * 4, 4);
		});
		release();

		gl.depthMask(false);
		gl.useProgram(programs.tube);
		setProjection(gl, programs.tube, args, tile);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.tube);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
		release = bindAttributes(gl, programs.tube, [['a_pos', 3, 0], ['a_color', 4, 3]], 7);
		gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
		release();
		gl.depthMask(true);
	}
}

// The layer is on the map while the 3D view is on and there's a profile. The line drawn on the ground
// fades in the 3D view.
export function createProfile3d(map) {
	const layer = new Profile3dLayer();
	const shown = () => !!(map.view3d && layer.profile);
	const keep = keepLayer(map, layer, shown, BEFORE_LAYER_ID);
	function sync() {
		keep();
		if(map.getLayer('planning-line')) map.setPaintProperty('planning-line', 'line-opacity', shown() ? 0.35 : 1);
	}
	map.on('style.load', sync);
	return {
		// profile: { a, b ([lon, lat]), samples (getProfileLines), hover (sample index or null) } or null
		set(profile) {
			layer.setProfile(profile);
			sync();
		},
	};
}
