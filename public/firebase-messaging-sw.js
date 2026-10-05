importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");
importScripts("/api/notifications/worker-config");

firebase.initializeApp(self.__ZONE_STREAM_FIREBASE_CONFIG__);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const url = typeof data.url === "string" ? data.url : "/dashboard";
  return self.registration.showNotification(data.title || "ZoneStream", {
    body: data.body || "There is an update from ZoneStream.",
    icon: "/logo.png",
    badge: "/logo.png",
    tag: data.tag || "zonestream-update",
    data: { url },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requestedUrl = event.notification.data && event.notification.data.url;
  const target = new URL(typeof requestedUrl === "string" ? requestedUrl : "/dashboard", self.location.origin);
  if (target.origin !== self.location.origin) return;

  event.waitUntil((async () => {
    const openClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of openClients) {
      if ("focus" in client) {
        await client.focus();
        if (client.url !== target.href && "navigate" in client) await client.navigate(target.href);
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
