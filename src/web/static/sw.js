// KCode PWA Service Worker
// Cache-first for static assets, network-first for API, offline fallback

const CACHE_NAME = "kcode-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/offline.html",
  "/styles.css",
  "/terminal-theme.css",
  "/dashboard.css",
  "/app.js",
  "/markdown.js",
  "/diff-viewer.js",
  "/model-dashboard.js",
  "/analytics-dashboard.js",
  "/session-viewer.js",
  "/config-panel.js",
  "/manifest.json",
];

// ─── Install: pre-cache static assets ──────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Activate immediately without waiting for existing clients to close
  self.skipWaiting();
});

// ─── Activate: clean up old caches ─────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

// ─── Fetch: routing strategy ────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  // Skip WebSocket upgrade requests
  if (url.pathname === "/ws") return;

  // Network-first for API calls
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first for static assets
  event.respondWith(cacheFirst(event.request));
});

// ─── Push notifications ─────────────────────────────────────────

self.addEventListener("push", (event) => {
  let data = { title: "KCode", body: "Notification", tag: "kcode-general" };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    tag: data.tag || "kcode-general",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [100, 50, 100],
    data: data,
    actions: [],
  };

  // Add action buttons for tool approval notifications
  if (data.tag === "kcode-permission") {
    options.actions = [
      { action: "allow", title: "Allow" },
      { action: "deny", title: "Deny" },
    ];
  }

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// ─── Notification click handling ────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const notifData = event.notification.data || {};
  const action = event.action; // "allow" or "deny" from action buttons

  // Handle permission response via action buttons
  if (notifData.tag === "kcode-permission" && notifData.permissionId && action) {
    event.waitUntil(
      fetch(`/api/v1/permission/${notifData.permissionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action === "allow" ? "allow" : "deny" }),
      }).catch(() => {
        // If the API call fails, just focus the window
      })
    );
  }

  // Focus the KCode window or open a new one
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow("/");
      })
  );
});

// ─── Strategies ─────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    // Cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // If both cache and network fail, show offline page for navigation
    if (request.mode === "navigate") {
      const offlinePage = await caches.match("/offline.html");
      if (offlinePage) return offlinePage;
    }
    return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
  }
}

async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);
    // Cache successful API responses for offline access
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // Fall back to cached API response
    const cached = await caches.match(request);
    if (cached) return cached;

    return new Response(
      JSON.stringify({ error: "Offline", offline: true }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
