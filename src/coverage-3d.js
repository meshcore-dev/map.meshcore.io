import { ProgramCache, bindAttributes, keepLayer, setProjection, tileAround } from './webgl-layer.js';

// The radio shadow of the selected coverage site in the 3D view: a see-through sheet where the line of
// sight from the antenna passes above the ground, at its height - how high a receiver (or a mast) has to
// be there to see the antenna. Where it reaches the ground (the antenna is in sight) there's nothing.
// Coloured by that height: yellow for a few metres, orange, magenta, violet up to 150 m, fading out above.
// Line of sight only (no diffraction, no path loss): it's not the coverage estimate itself, the
// signal also reaches into some of the shadow (and not everywhere in sight).
//
// A MapLibre custom WebGL layer (webgl-layer.js), from the coarse grid the coverage model fills
// (coverage-model.js: shadow). Heights are scaled like the terrain (its exaggeration).

const LAYER_ID = 'coverage-3d';
// drawn under these (the planning marks and the profile)
const BEFORE_LAYER_ID = 'planning-line';
// depth (m) -> colour
const COLOR_STOPS = [
	[5, [0.35, 0.8, 0.95]],
	[30, [0.25, 0.45, 0.95]],
	[100, [0.45, 0.25, 0.8]],
];
// depth (m) -> opacity: fades in above the ground, out where it's too high to be of use
const ALPHA_STOPS = [[5, 0], [15, 0.4], [100, 0.4], [200, 0]];

const VERTEX = `
	in vec3 a_pos;
	in vec4 a_color;
	out vec4 v_color;
	void main() {
		gl_Position = projectTileFor3D(a_pos.xy, a_pos.z);
		v_color = a_color;
	}`;

function interpolate(stops, value) {
	if(value <= stops[0][0]) return stops[0][1];
	for(let i = 1; i < stops.length; i++) {
		const [to, b] = stops[i];
		if(value <= to) {
			const [from, a] = stops[i - 1];
			const t = (value - from) / (to - from);
			return Array.isArray(a) ? a.map((v, k) => v + (b[k] - v) * t) : a + (b - a) * t;
		}
	}
	return stops.at(-1)[1];
}

// The sheet: a vertex per grid cell (x, y, z, r, g, b, a), triangles where it shows
function buildGeometry({ depth, ground, cells, left, top, size, worldSize }, exaggeration) {
	const toMercator = (cx, cy) => ({ x: (left + cx * size / cells) / worldSize, y: (top + cy * size / cells) / worldSize });
	const { tile, toTile } = tileAround(toMercator(0, 0), toMercator(cells, cells));
	const vertices = new Float32Array(cells * cells * 7);
	const shows = new Uint8Array(cells * cells);
	for(let cy = 0; cy < cells; cy++) {
		for(let cx = 0; cx < cells; cx++) {
			const i = cy * cells + cx;
			const d = depth[i];
			if(Number.isNaN(d)) continue;
			const { x, y } = toMercator(cx + 0.5, cy + 0.5);
			const [tx, ty] = toTile(x, y);
			const alpha = interpolate(ALPHA_STOPS, d);
			const color = interpolate(COLOR_STOPS, d);
			vertices.set([tx, ty, (ground[i] + d) * exaggeration, ...color, alpha], i * 7);
			shows[i] = alpha > 0 ? 2 : 1;
		}
	}
	const indices = [];
	for(let cy = 0; cy < cells - 1; cy++) {
		for(let cx = 0; cx < cells - 1; cx++) {
			const p = cy * cells + cx, q = p + cells;
			const corners = [shows[p], shows[p + 1], shows[q], shows[q + 1]];
			// all four with a height, at least one of them above the ground
			if(corners.includes(0) || !corners.includes(2)) continue;
			indices.push(p, q, p + 1, p + 1, q, q + 1);
		}
	}
	return { tile, vertices, indices: new Uint32Array(indices) };
}

class Coverage3dLayer {
	constructor() {
		this.id = LAYER_ID;
		this.type = 'custom';
		this.renderingMode = '3d';
		this.shadow = null;
		this.geometry = null;
		this.programs = new ProgramCache({ sheet: VERTEX });
	}
	setShadow(shadow) {
		if(shadow === this.shadow) return;
		this.shadow = shadow;
		this.geometry = null;
	}
	onAdd(map, gl) {
		this.map = map;
		this.buffers = { vertices: gl.createBuffer(), indices: gl.createBuffer() };
		this.uploaded = null;
	}
	onRemove(map, gl) {
		for(const buffer of Object.values(this.buffers)) gl.deleteBuffer(buffer);
		this.programs.delete(gl);
	}
	upload(gl) {
		const exaggeration = this.map.getTerrain()?.exaggeration ?? 1;
		if(!this.geometry || exaggeration !== this.geometry.exaggeration) {
			this.geometry = { ...buildGeometry(this.shadow, exaggeration), exaggeration };
		}
		if(this.uploaded === this.geometry) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.vertices);
		gl.bufferData(gl.ARRAY_BUFFER, this.geometry.vertices, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.geometry.indices, gl.STATIC_DRAW);
		this.uploaded = this.geometry;
	}
	render(gl, args) {
		if(!this.shadow) return;
		// the index buffer binding belongs to the bound vertex array: not one of MapLibre's
		gl.bindVertexArray(null);
		this.upload(gl);
		const { tile, indices } = this.geometry;
		if(!indices.length) return;
		const { sheet } = this.programs.get(gl, args.shaderData);

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.depthMask(false);
		gl.disable(gl.CULL_FACE);

		gl.useProgram(sheet);
		setProjection(gl, sheet, args, tile);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.vertices);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
		const release = bindAttributes(gl, sheet, [['a_pos', 3, 0], ['a_color', 4, 3]], 7);
		gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
		release();
		gl.depthMask(true);
	}
}

// The layer is on the map while the 3D view is on and a coverage site is selected
export function createCoverage3d(map) {
	const layer = new Coverage3dLayer();
	const sync = keepLayer(map, layer, () => !!(map.view3d && layer.shadow), BEFORE_LAYER_ID);
	return {
		// shadow: the selected site's (computeCoverage) or null
		set(shadow) {
			layer.setShadow(shadow);
			sync();
		},
	};
}
