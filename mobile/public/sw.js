// Service worker de Sightline mobile (version web installée) : affiche les notifications envoyées par le serveur et
// ouvre l'écran concerné au toucher. Aucun cache : l'app se met à jour à chaque déploiement.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Sightline", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "Sightline", {
    body: data.body || "",
    icon: "/app/icons/icon-192.png",
    badge: "/app/icons/icon-192.png",
    tag: data.tag,
    data: { url: data.url || "/app/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/app/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((w) => w.url.startsWith(`${self.location.origin}/app/`));
    if (open) {
      await open.focus();
      return open.navigate(url).catch(() => undefined);
    }
    return self.clients.openWindow(url);
  })());
});
