// Arrow-key navigation: left and right move between chapters, matching the
// prev/next cards at the foot of every page. Ignored while typing, and with
// modifier keys held.
addEventListener('keydown', (event) => {
	if (event.defaultPrevented) return;
	if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

	const target = event.target;
	if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]')) return;

	const selector =
		event.key === 'ArrowLeft' ? 'a[rel="prev"]' : event.key === 'ArrowRight' ? 'a[rel="next"]' : null;
	if (!selector) return;

	const link = document.querySelector(selector);
	if (link) {
		event.preventDefault();
		link.click();
	}
});
