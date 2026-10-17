// Progress tracker — client-side only.
//
// Everything lives in localStorage; nothing leaves the browser. Pages render
// fine without this script; with it, day pages gain a complete toggle, the
// days index gains counts and a Continue button, the sidebar gains a compact
// progress widget on every page, and day links gain a done mark.
(() => {
	const KEY = 'gtb.progress.v1';
	const DAYS = 60;
	// The site's base path ('' at the root, '/100-days-of-go-lang' on Pages),
	// set by an inline script in the page head.
	const BASE = document.documentElement.dataset.base ?? '';
	const DAY_PREFIX = `${BASE}/days/day-`;

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

	const dayLink = (n) => `${DAY_PREFIX}${String(n).padStart(2, '0')}/`;
	const nextOpen = (set) => {
		for (let i = 1; i <= DAYS; i++) if (!set.has(i)) return i;
		return null;
	};
	const percent = (count) => Math.round((count / DAYS) * 100);

	// Day links in the sidebar and the days-index list get a class and state.
	const updateDayLinks = () => {
		const set = read();
		for (const link of document.querySelectorAll(`a[href^="${DAY_PREFIX}"]`)) {
			link.classList.add('day-link');
			link.classList.toggle('done', set.has(Number(link.getAttribute('href').slice(DAY_PREFIX.length, -1))));
		}
	};

	// The full card: the days index and the home page carry its placeholder.
	const overview = document.getElementById('tracker-overview');
	const renderOverview = () => {
		if (!overview) return;
		const set = read();
		const count = set.size;
		const next = nextOpen(set);
		overview.innerHTML =
			'<div class="tracker-card">' +
			`<div class="tracker-count"><strong>${count}</strong> / ${DAYS} days complete</div>` +
			`<div class="tracker-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${DAYS}" aria-valuenow="${count}"><span style="width:${percent(count)}%"></span></div>` +
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
					refresh();
				}
			});
		}
	};

	// The compact widget: the top of the sidebar, on every page.
	let widget = null;
	const renderWidget = () => {
		if (!widget) return;
		const set = read();
		const count = set.size;
		const next = nextOpen(set);
		widget.innerHTML =
			`<div class="tracker-widget-count">${count} / ${DAYS} days</div>` +
			`<div class="tracker-bar"><span style="width:${percent(count)}%"></span></div>` +
			(next
				? `<a class="tracker-widget-link" href="${dayLink(next)}">${count ? `Continue → Day ${next}` : 'Begin at Day 1 →'}</a>`
				: '<div class="tracker-widget-link">All 60 days complete ✓</div>');
	};

	const refresh = () => {
		updateDayLinks();
		renderOverview();
		renderWidget();
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
				refresh();
			});
		};
		render();
	}

	// Mount the sidebar widget once the sidebar exists (it is server-rendered,
	// so this script sees it on load).
	const sidebar = document.querySelector('.sidebar-content');
	if (sidebar && !sidebar.querySelector('.tracker-widget')) {
		widget = document.createElement('div');
		widget.className = 'tracker-widget';
		sidebar.prepend(widget);
	}

	refresh();
})();
