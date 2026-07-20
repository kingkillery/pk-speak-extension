const CACHE_NAME = "pi-speak-remote-v5";
const APP_SHELL = [
	"/app/",
	"/app/app.webmanifest",
	"/app/icon.svg",
	"/app/live-capture-worklet.js",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(
				keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
			),
		).then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
	if (!url.pathname.startsWith("/app/")) return;
	if (url.pathname.startsWith("/app/sw.js")) return;
	if (url.pathname === "/app/" || url.pathname === "/app/index.html" || url.pathname === "/app/app.js") {
		event.respondWith(
			fetch(event.request)
				.then((response) => {
					const clone = response.clone();
					const canonical = new Request(`${url.origin}${url.pathname}`);
					caches.open(CACHE_NAME).then((cache) => cache.put(canonical, clone));
					return response;
				})
				.catch(async () => (await caches.match(event.request, { ignoreSearch: true })) || new Response(
					"Pi Speak gateway is unavailable.",
					{ status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
				)),
		);
		return;
	}

	event.respondWith(
		caches.match(event.request).then((cached) => {
			if (cached) return cached;
			return fetch(event.request).then((response) => {
				const clone = response.clone();
				caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
				return response;
			});
		}),
	);
});
