// ETH Cone v5.2 — Service Worker v4
// Fix: ใช้ fetch loop keep-alive ป้องกัน SW ถูก suspend
// Android Chrome จะไม่ kill SW ระหว่างที่มี fetch request

const BINANCE='https://fapi.binance.com/fapi/v1/ticker/price?symbol=ETHUSDT';

self.addEventListener('install',()=>self.skipWaiting());

self.addEventListener('activate',e=>e.waitUntil((async()=>{
  await self.clients.claim();
  // กู้คืน state หลัง SW restart
  try{
    const c=await caches.open('eth-sw-v4');
    const r=await c.match('/sw-state');
    if(r){
      const s=await r.json();
      if(s&&s.active&&s.endTime>Date.now()){
        _state=s;
        startLoop();
      }
    }
  }catch{}
})()));

let _loop=null;
let _state=null;

// ── Message handler ──
self.addEventListener('message',e=>{
  if(!e.data)return;
  switch(e.data.type){
    case 'ALERT':
      notify(e.data.title,e.data.body,e.data.tag||'eth');
      break;
    case 'TRADE_START':
      _state=e.data.state;
      saveState(_state);
      startLoop();
      break;
    case 'TRADE_STOP':
      stopLoop();
      _state=null;
      clearState();
      break;
    case 'TRADE_UPDATE':
      if(_state){Object.assign(_state,e.data.state);saveState(_state);}
      break;
    case 'PING':
      // keepalive from tab
      break;
  }
});

// ── Notification ──
function notify(title,body,tag='eth'){
  return self.registration.showNotification(title,{
    body,tag,renotify:true,
    vibrate:[300,100,300,100,300],
    requireInteraction:true,
    silent:false,
    icon:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Ethereum_logo_2014.svg/32px-Ethereum_logo_2014.svg.png',
    badge:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Ethereum_logo_2014.svg/32px-Ethereum_logo_2014.svg.png'
  });
}

// ── Main Loop ──
// ใช้ recursive fetch แทน setTimeout/setInterval
// fetch จะ keep SW alive บน Android Chrome
function startLoop(){
  stopLoop();
  runLoop(); // เริ่มทันที
}

function stopLoop(){
  if(_loop){clearTimeout(_loop);_loop=null;}
}

async function runLoop(){
  if(!_state||!_state.active){stopLoop();return;}

  try{
    await tick(); // fetch + check
  }catch(err){
    // network error — ลองใหม่
  }

  if(!_state||!_state.active){stopLoop();return;}

  // รอ 20s แล้วรันใหม่ — setTimeout ใช้ได้เพราะ SW เพิ่ง fetch เสร็จ
  // Chrome จะ keep SW alive อีก ~30s หลัง fetch
  _loop=setTimeout(runLoop, 20000);
}

async function tick(){
  if(!_state)return;
  const now=Date.now();

  // ── ตรวจ TIMEOUT ก่อน ──
  if(_state.endTime&&now>=_state.endTime){
    stopLoop();
    const dir=(_state.dir||'').toUpperCase();
    const entry=parseFloat(_state.entry||0).toFixed(2);
    await notify(
      `⏰ ETH ${dir}: TIMEOUT`,
      `หมดเวลา Monitoring\nEntry $${entry}`,
      'eth-timeout'
    );
    await broadcast({type:'SW_RESULT',result:'TIMEOUT',price:0});
    _state=null;clearState();
    return;
  }

  // ── Fetch ราคา — การ fetch นี้คือ keep-alive ของ SW ──
  const r=await fetch(BINANCE,{cache:'no-store'});
  const d=await r.json();
  const price=parseFloat(d.price);
  if(!price)return;

  const s=_state;
  const f=v=>parseFloat(v).toFixed(2);
  const rem=s.endTime?Math.max(0,Math.round((s.endTime-now)/60000)):'?';

  if(s.dir==='long'){
    if(!s.tp1Hit&&price>=s.tp1){
      s.tp1Hit=true;saveState(s);
      await notify('🎯 LONG TP1 HIT!',`$${f(price)} ≥ TP1 $${f(s.tp1)} | เหลือ ${rem}m`,'eth-tp1');
      await broadcast({type:'SW_TP1_HIT',price});
    }
    if(price>=s.tp2){
      stopLoop();
      const pnl=((price-s.entry)*s.qty).toFixed(2);
      await notify('🏆 LONG TP2 WIN!',`$${f(price)} | +$${pnl}`,'eth-tp2');
      await broadcast({type:'SW_RESULT',result:'TP2',price});
      _state=null;clearState();return;
    }
    if(price<=s.sl){
      stopLoop();
      const pnl=((s.entry-price)*s.qty).toFixed(2);
      await notify('🛑 LONG SL HIT',`$${f(price)} | -$${pnl}`,'eth-sl');
      await broadcast({type:'SW_RESULT',result:'SL',price});
      _state=null;clearState();return;
    }
  } else {
    if(!s.tp1Hit&&price<=s.tp1){
      s.tp1Hit=true;saveState(s);
      await notify('🎯 SHORT TP1 HIT!',`$${f(price)} ≤ TP1 $${f(s.tp1)} | เหลือ ${rem}m`,'eth-tp1');
      await broadcast({type:'SW_TP1_HIT',price});
    }
    if(price<=s.tp2){
      stopLoop();
      const pnl=((s.entry-price)*s.qty).toFixed(2);
      await notify('🏆 SHORT TP2 WIN!',`$${f(price)} | +$${pnl}`,'eth-tp2');
      await broadcast({type:'SW_RESULT',result:'TP2',price});
      _state=null;clearState();return;
    }
    if(price>=s.sl){
      stopLoop();
      const pnl=((price-s.entry)*s.qty).toFixed(2);
      await notify('🛑 SHORT SL HIT',`$${f(price)} | -$${pnl}`,'eth-sl');
      await broadcast({type:'SW_RESULT',result:'SL',price});
      _state=null;clearState();return;
    }
  }
}

// ── Broadcast กลับ Tab ──
async function broadcast(msg){
  try{
    const all=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    all.forEach(c=>c.postMessage(msg));
  }catch{}
}

// ── Cache State ──
async function saveState(s){
  try{const c=await caches.open('eth-sw-v4');await c.put('/sw-state',new Response(JSON.stringify(s)));}catch{}
}
async function clearState(){
  try{const c=await caches.open('eth-sw-v4');await c.delete('/sw-state');}catch{}
}

// ── Notification Click ──
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
      if(cs.length>0)return cs[0].focus();
      return self.clients.openWindow('/Eth-cone-upp/');
    })
  );
});
