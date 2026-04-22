// ETH Cone v5.2 — Service Worker
// อัปโหลดไฟล์นี้ขึ้น GitHub repo รูท (upperpulse/Eth-cone/sw.js)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'ALERT') return;
  const opts = {
    body: e.data.body || '',
    tag: e.data.tag || 'eth-cone',
    renotify: true,
    vibrate: [300, 100, 300, 100, 300],
    requireInteraction: false,
    silent: false,
    icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Ethereum_logo_2014.svg/32px-Ethereum_logo_2014.svg.png',
    badge: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Ethereum_logo_2014.svg/32px-Ethereum_logo_2014.svg.png'
  };
  e.waitUntil(self.registration.showNotification(e.data.title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(cs => {
      if (cs.length > 0) cs[0].focus();
      else clients.openWindow('/Eth-cone-upp/');
    })
  );
});
