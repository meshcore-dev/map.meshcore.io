// Point-to-point profile chart: the terrain (raised by the earth's bulge, so the line of sight is
// straight), trees on it, the line of sight between the antennas and the first Fresnel zone around it

const PADDING = { left: 54, right: 10, top: 10, bottom: 22 };
const EARTH_RADIUS = 6371008.8;
// the Fresnel zone counts as clear with 60 % of it free
const FRESNEL_CLEAR = 0.6;

const THEMES = {
	light: {
		background: '#f4f6f9',
		grid: 'rgba(0, 0, 0, 0.09)',
		text: '#555',
		terrain: '#b9a99a',
		terrainEdge: '#8d7b6a',
		trees: 'rgba(67, 160, 71, 0.75)',
		fresnel: 'rgba(229, 57, 53, 0.13)',
		fresnelEdge: 'rgba(229, 57, 53, 0.55)',
		los: '#1e88e5',
		blocked: '#d32f2f',
		hover: 'rgba(0, 0, 0, 0.55)',
		tooltip: 'rgba(255, 255, 255, 0.92)',
	},
	dark: {
		background: '#1b2230',
		grid: 'rgba(255, 255, 255, 0.09)',
		text: '#b8c0cc',
		terrain: '#6b5d52',
		terrainEdge: '#a08c7b',
		trees: 'rgba(76, 175, 80, 0.7)',
		fresnel: 'rgba(239, 83, 80, 0.16)',
		fresnelEdge: 'rgba(239, 83, 80, 0.6)',
		los: '#64b5f6',
		blocked: '#ff5252',
		hover: 'rgba(255, 255, 255, 0.6)',
		tooltip: 'rgba(27, 34, 48, 0.92)',
	},
};

// Heights along the path (m above sea level, with the earth's bulge) for antenna heights a and b:
// { x (m), bulge, ground, top (ground + trees), los, fresnel (first zone radius) } per sample
export function getProfileLines(result, heightA, heightB) {
	const { elevations, trees, stepLength, distance, wavelength, refractionK } = result;
	const last = elevations.length - 1;
	const losA = elevations[0] + heightA, losB = elevations[last] + heightB;
	const samples = [];
	for(let i = 0; i <= last; i++) {
		const x = i * stepLength;
		const bulge = x * (distance - x) / (2 * refractionK * EARTH_RADIUS);
		const ground = elevations[i] + bulge;
		samples.push({
			x,
			bulge,
			ground,
			top: ground + trees[i],
			los: losA + (losB - losA) * x / distance,
			fresnel: Math.sqrt(wavelength * x * (distance - x) / distance),
		});
	}
	return samples;
}

// How free the path is: the least free share of the first Fresnel zone (1: clear, 0: the line of
// sight touches the terrain, below 0: blocked) and what that means
export function getClearance(samples) {
	let worst = Infinity;
	for(const { top, los, fresnel } of samples) {
		if(fresnel > 0) worst = Math.min(worst, (los - top) / fresnel);
	}
	const status = worst >= FRESNEL_CLEAR ? 'clear' : worst >= 0 ? 'fresnel' : 'blocked';
	return { worst, status };
}

function niceStep(range, targetCount) {
	const raw = range / targetCount;
	const power = 10 ** Math.floor(Math.log10(raw));
	return [1, 2, 2.5, 5, 10].map(m => m * power).find(step => step >= raw);
}

// Draws the chart; `hover` is a sample index or null. Returns the sample index at a canvas x.
export function drawProfileChart(canvas, samples, { dark = false, hover = null } = {}) {
	const theme = THEMES[dark ? 'dark' : 'light'];
	const width = canvas.clientWidth, height = canvas.clientHeight;
	const ratio = devicePixelRatio;
	if(canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
	}
	const ctx = canvas.getContext('2d');
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.fillStyle = theme.background;
	ctx.fillRect(0, 0, width, height);
	if(samples.length < 2) return () => null;

	const distance = samples.at(-1).x;
	let low = Infinity, high = -Infinity;
	for(const { ground, top, los, fresnel } of samples) {
		low = Math.min(low, ground);
		high = Math.max(high, top, los + fresnel);
	}
	const span = Math.max(20, high - low);
	low -= span * 0.05;
	high += span * 0.08;

	const plotWidth = width - PADDING.left - PADDING.right;
	const plotHeight = height - PADDING.top - PADDING.bottom;
	const toX = x => PADDING.left + x / distance * plotWidth;
	const toY = h => PADDING.top + (high - h) / (high - low) * plotHeight;

	ctx.save();
	ctx.beginPath();
	ctx.rect(PADDING.left, PADDING.top, plotWidth, plotHeight);
	ctx.clip();

	// elevation grid lines, bent by the earth's bulge like the terrain
	const elevationStep = niceStep(high - low, 5);
	const gridPoints = Array.from({ length: 41 }, (_, j) => samples[Math.round(j / 40 * (samples.length - 1))]);
	ctx.strokeStyle = theme.grid;
	ctx.lineWidth = 1;
	for(let h = Math.ceil((low - samples[samples.length >> 1].bulge) / elevationStep) * elevationStep; h <= high; h += elevationStep) {
		ctx.beginPath();
		for(const { x, bulge } of gridPoints) ctx.lineTo(toX(x), toY(h + bulge));
		ctx.stroke();
	}

	// Fresnel zone
	ctx.beginPath();
	samples.forEach(({ x, los, fresnel }) => ctx.lineTo(toX(x), toY(los + fresnel)));
	for(let i = samples.length - 1; i >= 0; i--) ctx.lineTo(toX(samples[i].x), toY(samples[i].los - samples[i].fresnel));
	ctx.closePath();
	ctx.fillStyle = theme.fresnel;
	ctx.fill();
	ctx.strokeStyle = theme.fresnelEdge;
	ctx.stroke();

	// trees, then the ground over them
	ctx.beginPath();
	ctx.moveTo(toX(0), toY(low));
	samples.forEach(({ x, top }) => ctx.lineTo(toX(x), toY(top)));
	ctx.lineTo(toX(distance), toY(low));
	ctx.fillStyle = theme.trees;
	ctx.fill();
	ctx.beginPath();
	ctx.moveTo(toX(0), toY(low));
	samples.forEach(({ x, ground }) => ctx.lineTo(toX(x), toY(ground)));
	ctx.lineTo(toX(distance), toY(low));
	ctx.fillStyle = theme.terrain;
	ctx.fill();
	ctx.beginPath();
	samples.forEach(({ x, ground }) => ctx.lineTo(toX(x), toY(ground)));
	ctx.strokeStyle = theme.terrainEdge;
	ctx.lineWidth = 1.2;
	ctx.stroke();

	// where the terrain (or trees) cuts the line of sight
	ctx.strokeStyle = theme.blocked;
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	let drawing = false;
	for(const { x, top, los } of samples) {
		if(top > los) {
			if(!drawing) ctx.moveTo(toX(x), toY(top));
			else ctx.lineTo(toX(x), toY(top));
			drawing = true;
		} else {
			drawing = false;
		}
	}
	ctx.stroke();

	// line of sight between the antennas, and the masts
	const first = samples[0], last = samples.at(-1);
	ctx.strokeStyle = theme.los;
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(toX(0), toY(first.los));
	ctx.lineTo(toX(distance), toY(last.los));
	ctx.stroke();
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.moveTo(toX(0) + 1.5, toY(first.ground));
	ctx.lineTo(toX(0) + 1.5, toY(first.los));
	ctx.moveTo(toX(distance) - 1.5, toY(last.ground));
	ctx.lineTo(toX(distance) - 1.5, toY(last.los));
	ctx.stroke();
	ctx.restore();

	// axes
	ctx.fillStyle = theme.text;
	ctx.font = '11px system-ui, sans-serif';
	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';
	for(let h = Math.ceil(low / elevationStep) * elevationStep; h <= high; h += elevationStep) {
		ctx.fillText(`${Math.round(h)} m`, PADDING.left - 5, toY(h));
	}
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	const kmStep = niceStep(distance / 1000, Math.max(2, Math.floor(plotWidth / 70)));
	for(let km = 0; km <= distance / 1000 + 1e-9; km += kmStep) {
		ctx.fillText(km === 0 ? '0' : `${+km.toFixed(2)} km`, toX(km * 1000), height - PADDING.bottom + 5);
	}

	// hovered spot
	if(hover !== null && samples[hover]) {
		const { x, bulge, ground, top, los } = samples[hover];
		ctx.strokeStyle = theme.hover;
		ctx.lineWidth = 1;
		ctx.setLineDash([3, 3]);
		ctx.beginPath();
		ctx.moveTo(toX(x), PADDING.top);
		ctx.lineTo(toX(x), PADDING.top + plotHeight);
		ctx.stroke();
		ctx.setLineDash([]);

		const trees = top - ground;
		const lines = [
			`${(x / 1000).toFixed(2)} km`,
			`elevation ${Math.round(ground - bulge)} m${trees > 0.5 ? ` + ${Math.round(trees)} m trees` : ''}`,
			`line of sight ${los - top >= 0 ? `${Math.round(los - top)} m above` : `${Math.round(top - los)} m below`}`,
		];
		ctx.font = '11px system-ui, sans-serif';
		const boxWidth = Math.max(...lines.map(line => ctx.measureText(line).width)) + 12;
		const boxHeight = lines.length * 14 + 8;
		let boxX = toX(x) + 8;
		if(boxX + boxWidth > width - 4) boxX = toX(x) - 8 - boxWidth;
		ctx.fillStyle = theme.tooltip;
		ctx.fillRect(boxX, PADDING.top + 4, boxWidth, boxHeight);
		ctx.fillStyle = theme.text;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		lines.forEach((line, i) => ctx.fillText(line, boxX + 6, PADDING.top + 8 + i * 14));
	}

	return canvasX => {
		const share = (canvasX - PADDING.left) / plotWidth;
		if(share < 0 || share > 1) return null;
		return Math.round(share * (samples.length - 1));
	};
}
