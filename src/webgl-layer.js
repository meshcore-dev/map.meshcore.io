import { MercatorCoordinate } from '../lib/maplibre-gl.mjs';

// Shared parts of the custom WebGL layers in the 3D view (profile-3d.js, coverage-3d.js): shaders that
// project with MapLibre's own code (flat map or globe), positions in the units of one map tile
// (precise close up) and heights in metres.

// tile units (MapLibre's EXTENT)
export const EXTENT = 8192;

export const FRAGMENT_SHADER = `#version 300 es
	precision mediump float;
	in vec4 v_color;
	out vec4 fragColor;
	void main() {
		fragColor = vec4(v_color.rgb * v_color.a, v_color.a);
	}`;

function compile(gl, vertexSource, fragmentSource) {
	const program = gl.createProgram();
	for(const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
		gl.attachShader(program, shader);
	}
	gl.linkProgram(program);
	if(!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
	return program;
}

// Programs ({ name: vertex shader body }, the body calls projectTileFor3D(xy, elevation)), compiled
// once per projection variant (MapLibre's shader code differs)
export class ProgramCache {
	constructor(vertexBodies) {
		this.vertexBodies = vertexBodies;
		this.variants = new Map();
	}
	get(gl, { variantName, vertexShaderPrelude, define }) {
		let programs = this.variants.get(variantName);
		if(!programs) {
			programs = {};
			for(const [name, body] of Object.entries(this.vertexBodies)) {
				programs[name] = compile(gl, `#version 300 es\n${vertexShaderPrelude}\n${define}\n${body}`, FRAGMENT_SHADER);
			}
			this.variants.set(variantName, programs);
		}
		return programs;
	}
	delete(gl) {
		for(const programs of this.variants.values()) {
			for(const program of Object.values(programs)) gl.deleteProgram(program);
		}
		this.variants.clear();
	}
}

// A tile about as big as a box of mercator coordinates ({ x, y } corners) and the conversion of
// mercator coordinates into its units
export function tileAround(from, to) {
	const span = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1e-7);
	const z = Math.max(0, Math.min(16, Math.floor(-Math.log2(span))));
	const tiles = 2 ** z;
	const tile = { z, x: Math.floor(Math.min(from.x, to.x) * tiles), y: Math.floor(Math.min(from.y, to.y) * tiles) };
	return {
		tile,
		toTile: (mx, my) => [(mx * tiles - tile.x) * EXTENT, (my * tiles - tile.y) * EXTENT],
		// metres in tile units, horizontally, at a mercator coordinate
		unitAt: coordinate => coordinate.meterInMercatorCoordinateUnits() * tiles * EXTENT,
	};
}

export const mercator = lngLat => MercatorCoordinate.fromLngLat(lngLat, 0);

// MapLibre's projection uniforms for a tile
export function setProjection(gl, program, args, tile) {
	const projection = args.getProjectionData({
		tileID: { canonical: { z: tile.z, x: tile.x, y: tile.y }, wrap: 0 },
		applyGlobeMatrix: true,
	});
	const location = name => gl.getUniformLocation(program, name);
	gl.uniformMatrix4fv(location('u_projection_matrix'), false, projection.mainMatrix);
	gl.uniformMatrix4fv(location('u_projection_fallback_matrix'), false, projection.fallbackMatrix);
	gl.uniform4f(location('u_projection_tile_mercator_coords'), ...projection.tileMercatorCoords);
	gl.uniform4f(location('u_projection_clipping_plane'), ...projection.clippingPlane);
	gl.uniform1f(location('u_projection_transition'), projection.projectionTransition);
}

// Float attributes ([name, size, offset] in floats) of the bound buffer; returns a function that
// disables them again
export function bindAttributes(gl, program, attributes, stride) {
	const locations = [];
	for(const [name, size, offset] of attributes) {
		const location = gl.getAttribLocation(program, name);
		if(location < 0) continue;
		gl.enableVertexAttribArray(location);
		gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride * 4, offset * 4);
		locations.push(location);
	}
	return () => locations.forEach(location => gl.disableVertexAttribArray(location));
}

// Keeps a custom layer on the map while show() is true (custom layers don't survive a new style:
// added again on every style load). Returns a function to call when show() may have changed.
export function keepLayer(map, layer, show, beforeId) {
	function sync() {
		if(!map.style?._loaded) return;
		const on = show();
		if(on && !map.getLayer(layer.id)) map.addLayer(layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
		else if(!on && map.getLayer(layer.id)) map.removeLayer(layer.id);
		map.triggerRepaint();
	}
	map.on('style.load', sync);
	return sync;
}
