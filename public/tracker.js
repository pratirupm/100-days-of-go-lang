// Progress tracker — client-side only.
//
// Everything lives in localStorage; nothing leaves the browser. Pages render
// fine without this script; with it, day pages gain a complete toggle, the
// days index gains counts and a Continue button, and chapter badges gain a
// done mark.
(() => {
	const KEY = 'gtb.progress.v1';
	const DAYS = 60;
	// The site's base path ('' at the root, '/100-days-of-go-lang' on Pages),
	// set by an inline script in the page head.
	const BASE = document.documentElement.dataset.base ?? '';

	const read = () => {
		try {
			const raw = localStorage.getItem(KEY);
			if (!raw) return new Set();
			const data = JSON.parse(raw);
			const days = Array.isArray(data.days) ? data.days : [];
			return new Set(days.filter((d) => Number.isInteger(d) && d >= 1 && d <= DAYS));
		} catch {
			return new Set();
		}
	};
	const write = (set) => {
		try {
			localStorage.setItem(KEY, JSON.stringify({ days: [...set].sort((a, b) => a - b) }));
			return true;
		} catch {
			return false;
		}
	};

	const dayLink = (n) => `${BASE}/days/day-${String(n).padStart(2, '0')}/`;
	const nextOpen = (set) => {
		for (let i = 1; i <= DAYS; i++) if (!set.has(i)) return i;
		return null;
	};

	const updateBadges = () => {
		for (const badge of document.querySelectorAll('.day-badge[data-day]')) {
			const n = Number(badge.dataset.day);
			badge.classList.toggle('done', read().has(n));
		}
	};

	const updateIndexMarks = () => {
		const set = read();
		for (const link of document.querySelectorAll('a[href^="/days/day-"]')) {
			const match = link.getAttribute('href').match(/day-(\d+)/);
			if (match) link.classList.toggle('done', set.has(Number(match[1])));
		}
	};

	const overview = document.getElementById('tracker-overview');
	const renderOverview = () => {
		if (!overview) return;
		const set = read();
		const count = set.size;
		const next = nextOpen(set);
		overview.innerHTML =
			'<div class="tracker-card">' +
			`<div class="tracker-count"><strong>${count}</strong> / ${DAYS} days complete</div>` +
			`<div class="tracker-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${DAYS}" aria-valuenow="${count}"><span style="width:${Math.round((count / DAYS) * 100)}%"></span></div>` +
			(next
				? `<a class="tracker-continue" href="${dayLink(next)}">Continue at Day ${next} →</a>`
				: '<div class="tracker-finish">All 60 days complete — the next test is yours.</div>') +
			(count ? '<button type="button" class="tracker-reset">Reset progress</button>' : '') +
			'</div>';
		const reset = overview.querySelector('.tracker-reset');
		if (reset) {
			reset.addEventListener('click', () => {
				if (confirm('Clear your saved progress in this browser?')) {
					write(new Set());
					renderOverview();
					updateIndexMarks();
				}
			});
		}
		updateIndexMarks();
	};

	// Day pages: one complete toggle each.
	for (const el of document.querySelectorAll('.day-tracker[data-day]')) {
		const n = Number(el.dataset.day);
		const render = () => {
			const complete = read().has(n);
			el.innerHTML =
				`<button type="button" class="day-toggle" aria-pressed="${complete}">` +
				(complete ? `✓ Day ${n} complete` : `Mark Day ${n} complete`) +
				'</button><span class="day-note">saved in this browser only</span>';
			el.querySelector('button').addEventListener('click', () => {
				const set = read();
				if (set.has(n)) set.delete(n);
				else set.add(n);
				write(set);
				render();
				updateBadges();
				renderOverview();
			});
		};
		render();
	}

	updateBadges();
	renderOverview();
})();
