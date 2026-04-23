// ETH Cone v5.2 — Service Worker v3
// Fix: TIMEOUT notification เมื่อปิด Tab

const BINANCE='https://fapi.binance.com/fapi/v1/ticker/price?symbol=ETHUSDT';
const STORE='eth_cone_sw_state'; // cache key สำรอง

self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));

let _watchInterval=null;
let _timeoutTimer=null;
let _tradeState=null;

// ── รับ message จาก Tab ──
self.addEventListener('message',e=>{
  if(!e.data)return;
  switch(e.data.type){
    case 'ALERT':
      showNotif(e.data.title,e.data.body,e.data.tag||'eth');
      break;
    case 'TRADE_START':
      _tradeState=e.data.state;
      // บันทึกลง Cache เผื่อ SW restart
      saveSWState(_tradeState);
      startWatchLoop();
      startTimeoutTimer();
      break;
    case 'TRADE_STOP':
      stopAll();
      _tradeState=null;
      clearSWState();
      break;
    case 'TRADE_UPDATE':
      if(_tradeState){
        Object.assign(_tradeState,e.data.state);
        saveSWState(_tradeState);
      }
      break;
  }
});

// ── Notification ──
function showNotif(title,body,tag='eth'){
  return self.registration.showNotification(title,{
    body,tag,renotify:true,
    vibrate:[300,100,300,100,300],
    requireInteraction:true,
    silent:false,
    icon:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Ethereum_logo_2014.svg/32px-Ethereum_logo_2014.svg.png',
    badge:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Ethereum_logo_2014.svg/32px-Ethereum_logo_2014.svg.png'
  });
}

// ── Stop everything ──
function stopAll(){
  if(_watchInterval){clearInterval(_watchInterval);_watchInterval=null;}
  if(_timeoutTimer){clearTimeout(_timeoutTimer);_timeoutTimer=null;}
}

// ── TIMEOUT TIMER — แยก timer ตรงๆ ไม่พึ่ง interval ──
// นี่คือ fix หลัก: ใช้ setTimeout ตรงๆ เมื่อรู้ endTime
function startTimeoutTimer(){
  if(_timeoutTimer){clearTimeout(_timeoutTimer);_timeoutTimer=null;}
  if(!_tradeState||!_tradeState.endTime)return;
  const remaining=_tradeState.endTime-Date.now();
  if(remaining<=0){
    handleTimeout();
    return;
  }
  // ตั้ง timer ตรงๆ ณ เวลา endTime
  _timeoutTimer=setTimeout(handleTimeout, remaining);
}

async function handleTimeout(){
  stopAll();
  await showNotif(
    '⏰ ETH Trade: TIMEOUT',
    `หมดเวลา Monitoring\n${_tradeState?(_tradeState.dir||'').toUpperCase()+' Entry $'+parseFloat(_tradeState.entry||0).toFixed(2):''}`,
    'eth-timeout'
  );
  broadcastToTabs({type:'SW_RESULT',result:'TIMEOUT',price:0});
  _tradeState=null;
  clearSWState();
}

// ── WATCH LOOP — ตรวจ TP/SL ทุก 15s ──
function startWatchLoop(){
  if(_watchInterval){clearInterval(_watchInterval);_watchInterval=null;}
  // tick แรกทันที ไม่รอ 15s
  watchTrade();
  _watchInterval=setInterval(watchTrade,15000);
}

async function watchTrade(){
  if(!_tradeState||!_tradeState.active)return;

  // double-check timeout (กรณี SW restart แล้ว setTimeout หาย)
  if(_tradeState.endTime&&Date.now()>=_tradeState.endTime){
    handleTimeout();
    return;
  }

  let price;
  try{
    const r=await fetch(BINANCE);
    const d=await r.json();
    price=parseFloat(d.price);
  }catch{return;}
  if(!price)return;

  const s=_tradeState;
  const f=v=>parseFloat(v).toFixed(2);
  const rem=s.endTime?Math.round((s.endTime-Date.now())/60000):'?';

  if(s.dir==='long'){
    if(!s.tp1Hit&&price>=s.tp1){
      s.tp1Hit=true;saveSWState(s);
      await showNotif('🎯 LONG TP1 HIT!',`$${f(price)} ≥ TP1 $${f(s.tp1)} | เหลือ ${rem}m`,'eth-tp1');
      broadcastToTabs({type:'SW_TP1_HIT',price});
    }
    if(price>=s.tp2){
      stopAll();
      await showNotif('🏆 LONG TP2 WIN!',`$${f(price)} | +$${f((price-s.entry)*s.qty)}`,'eth-tp2');
      broadcastToTabs({type:'SW_RESULT',result:'TP2',price});
      _tradeState=null;clearSWState();return;
    }
    if(price<=s.sl){
      stopAll();
      await showNotif('🛑 LONG SL HIT',`$${f(price)} | -$${f((s.entry-price)*s.qty)}`,'eth-sl');
      broadcastToTabs({type:'SW_RESULT',result:'SL',price});
      _tradeState=null;clearSWState();return;
    }
  }else{
    if(!s.tp1Hit&&price<=s.tp1){
      s.tp1Hit=true;saveSWState(s);
      await showNotif('🎯 SHORT TP1 HIT!',`$${f(price)} ≤ TP1 $${f(s.tp1)} | เหลือ ${rem}m`,'eth-tp1');
      broadcastToTabs({type:'SW_TP1_HIT',price});
    }
    if(price<=s.tp2){
      stopAll();
      await showNotif('🏆 SHORT TP2 WIN!',`$${f(price)} | +$${f((s.entry-price)*s.qty)}`,'eth-tp2');
      broadcastToTabs({type:'SW_RESULT',result:'TP2',price});
      _tradeState=null;clearSWState();return;
    }
    if(price>=s.sl){
      stopAll();
      await showNotif('🛑 SHORT SL HIT',`$${f(price)} | -$${f((price-s.entry)*s.qty)}`,'eth-sl');
      broadcastToTabs({type:'SW_RESULT',result:'SL',price});
      _tradeState=null;clearSWState();return;
    }
  }
}

// ── Broadcast กลับ Tab ──
async function broadcastToTabs(msg){
  const all=await self.clients.matchAll({type:'window'});
  all.forEach(c=>c.postMessage(msg));
}

// ── Cache state เผื่อ SW restart ──
async function saveSWState(state){
  try{
    const c=await caches.open('eth-sw-v3');
    await c.put('/sw-state',new Response(JSON.stringify(state)));
  }catch{}
}
async function clearSWState(){
  try{const c=await caches.open('eth-sw-v3');await c.delete('/sw-state');}catch{}
}

// ── SW restart: โหลด state กลับมา ──
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    await self.clients.claim();
    try{
      const c=await caches.open('eth-sw-v3');
      const r=await c.match('/sw-state');
      if(r){
        const state=await r.json();
        if(state&&state.active&&state.endTime>Date.now()){
          _tradeState=state;
          startWatchLoop();
          startTimeoutTimer();
          console.log('[SW] Restored trade state after restart');
        }
      }
    }catch{}
  })());
});

// ── Notification click ──
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:'window'}).then(cs=>{
      if(cs.length>0)return cs[0].focus();
      return self.clients.openWindow('/Eth-cone-upp/');
    })
  );
});
