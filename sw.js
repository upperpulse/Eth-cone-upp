// ETH Cone SW v5 — Minimal
// หน้าที่: รับ ALERT จาก Dashboard เท่านั้น
// VM Bot รับหน้าที่ Trade Monitor แทนแล้ว

self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));

self.addEventListener('message',e=>{
  if(!e.data)return;
  if(e.data.type==='ALERT'){
    self.registration.showNotification(e.data.title,{
      body:e.data.body,
      tag:e.data.tag||'eth',
      renotify:true,
      vibrate:[200,100,200],
      silent:false
    });
  }
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:'window'}).then(cs=>{
      if(cs.length>0)return cs[0].focus();
      return self.clients.openWindow('/Eth-cone-upp/');
    })
  );
});
