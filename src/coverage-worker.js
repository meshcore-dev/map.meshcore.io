import { computeCoverageGrid, computeProfile } from './coverage-model.js';

// Coverage estimates and point-to-point profiles off the main thread (see coverage.js)
self.onmessage = async ({ data: { id, kind, job } }) => {
	try {
		if(kind === 'profile') {
			const result = await computeProfile(job);
			self.postMessage({ id, result }, [result.elevations.buffer, result.trees.buffer]);
			return;
		}
		const result = await computeCoverageGrid(job);
		// the grids are big: hand them over instead of copying
		self.postMessage({ id, result }, [result.grid.margins.buffer, result.grid.clutter.buffer]);
	} catch(e) {
		self.postMessage({ id, error: e.message });
	}
};
