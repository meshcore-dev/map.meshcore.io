import { ref } from '../lib/vue.esm-browser.prod.js';
import { compassPoint } from './utils.js';

// A slider with its value next to it, which can also be typed in. The value shows while dragging,
// but is only set on release, a key press or Enter: every new value restarts the coverage estimate.
export const SettingSlider = {
	props: {
		modelValue: { type: Number, required: true },
		min: { type: Number, required: true },
		max: { type: Number, required: true },
		step: { type: Number, default: 1 },
		unit: { type: String, default: '' },
		// a bearing: show its compass point (NNE, SSE, ...) too
		compass: { type: Boolean, default: false },
	},
	emits: ['update:modelValue'],
	setup(props, { emit }) {
		const draft = ref(null);
		function set(value) {
			if(value !== props.modelValue) emit('update:modelValue', value);
		}
		function commitSlider(event) {
			draft.value = null;
			set(Number(event.target.value));
		}
		// typed values are kept in range and on the steps; anything else puts the old value back
		function commitNumber(event) {
			const typed = event.target.valueAsNumber;
			if(Number.isFinite(typed)) {
				const { min, max, step } = props;
				const value = Math.min(max, Math.max(min, min + Math.round((typed - min) / step) * step));
				set(Number(value.toFixed(6)));
			}
			event.target.value = props.modelValue;
		}
		return { draft, commitSlider, commitNumber, compassPoint };
	},
	template: `
		<div class="setting-slider">
			<label class="slider tiny">
				<input type="range" :min :max :step :value="draft ?? modelValue"
					@input="draft = Number($event.target.value)" @change="commitSlider">
				<span></span>
			</label>
			<span class="setting-value">
				<input type="number" class="setting-number" :min :max :step :value="draft ?? modelValue"
					@change="commitNumber" @keydown.enter="$event.target.blur()">
				<span :class="['setting-unit', { degrees: unit === '°' }]">{{ unit }}{{ compass ? ' ' + compassPoint(draft ?? modelValue) : '' }}</span>
			</span>
		</div>
	`,
};
