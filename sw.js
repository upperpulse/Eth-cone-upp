// ETH Cone v5.2 — Service Worker v2
// แก้ปัญหา: ปิด Tab แล้วยังส่ง Notification ได้
// หลักการ: SW fetch ราคา Binance เองทุก 15s เมื่อ trade active

const BINANCE='https://fapi.binance.com/fapi/v1/ticker/price?symbol=ETHUSDT';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

let _watchInterval=null;
let _tradeState=null;

self.addEventListener('message', e => {
  if(!e.data)return;
  switch(e.data.type){
    case 'ALERT':
      showNotif(e.data.title,e.data.body,e.data.tag||'eth');
      break;
    case 'TRADE_START':
      _tradeState=e.data.state;
      startWatchLoop();
      break;
    case 'TRADE_STOP':
      stopWatchLoop();
      _tradeState=null;
      break;
    case 'TRADE_UPDATE':
      if(_tradeState)Object.assign(_tradeState,e.data.state);
      break;
  }
});

function showNotif(title,body,tag='eth'){
  return self.registration.showNotification(title,{
    body,tag,renotify:true,
    vibrate:[300,100,300,100,300],
    requireInteraction:false,silent:false,
    icon:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Ethereum_logo_2014.svg/32px-Ethereum_logo_2014.svg.png',
    badge:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Ethereum_logo_2014.svg/32px-Ethereum_logo_2014.svg.png'
  });
}

function startWatchLoop(){
  stopWatchLoop();
  _watchInterval=setInterval(watchTrade,15000);
}
function stopWatchLoop(){
  if(_watchInterval){clearInterval(_watchInterval);_watchInterval=null;}
}

async function watchTrade(){
  if(!_tradeState||!_tradeState.active){stopWatchLoop();return;}
  const now=Date.now();
  if(_tradeState.endTime&&now>=_tradeState.endTime){
    stopWatchLoop();
    await showNotif('⏰ ETH Trade: TIMEOUT','หมดเวลา Monitoring แล้ว กลับมาดูผลได้เลย');
    _tradeState=null;return;
  }
  let price;
  try{
    const r=await fetch(BINANCE);
    const d=await r.json();
    price=parseFloat(d.price);
  }catch{return;}
  if(!price)return;

  const s=_tradeState;
  const fmt=v=>parseFloat(v).toFixed(2);
  const remaining=s.endTime?Math.round((s.endTime-now)/60000):'?';

  if(s.dir==='long'){
    if(!s.tp1Hit&&price>=s.tp1){
      s.tp1Hit=true;
      await showNotif('🎯 ETH LONG: TP1 HIT!',`ราคา $${fmt(price)} ถึง TP1 $${fmt(s.tp1)} | เหลือ ${remaining}m`,'eth-tp1');
      broadcastToTabs({type:'SW_TP1_HIT',price});
    }
    if(price>=s.tp2){
      stopWatchLoop();
      await showNotif('🏆 ETH LONG: TP2 WIN!',`ราคา $${fmt(price)} | +$${fmt((price-s.entry)*s.qty)}`,'eth-tp2');
      broadcastToTabs({type:'SW_RESULT',result:'TP2',price});
      _tradeState=null;return;
    }
    if(price<=s.sl){
      stopWatchLoop();
      await showNotif('🛑 ETH LONG: SL HIT',`ราคา $${fmt(price)} | -$${fmt((s.entry-price)*s.qty)}`,'eth-sl');
      broadcastToTabs({type:'SW_RESULT',result:'SL',price});
      _tradeState=null;return;
    }
  }else{
    if(!s.tp1Hit&&price<=s.tp1){
      s.tp1Hit=true;
      await showNotif('🎯 ETH SHORT: TP1 HIT!',`ราคา $${fmt(price)} ถึง TP1 $${fmt(s.tp1)} | เหลือ ${remaining}m`,'eth-tp1');
      broadcastToTabs({type:'SW_TP1_HIT',price});
    }
    if(price<=s.tp2){
      stopWatchLoop();
      await showNotif('🏆 ETH SHORT: TP2 WIN!',`ราคา $${fmt(price)} | +$${fmt((s.entry-price)*s.qty)}`,'eth-tp2');
      broadcastToTabs({type:'SW_RESULT',result:'TP2',price});
      _tradeState=null;return;
    }
    if(price>=s.sl){
      stopWatchLoop();
      await showNotif('🛑 ETH SHORT: SL HIT',`ราคา $${fmt(price)} | -$${fmt((price-s.entry)*s.qty)}`,'eth-sl');
      broadcastToTabs({type:'SW_RESULT',result:'SL',price});
      _tradeState=null;return;
    }
  }

  // Zone alerts (ไม่ซ้ำ — ใช้ tag unique)
  if(s.shortLow&&price>=s.shortLow&&price<=s.shortHigh){
    showNotif('🔴 SHORT ZONE!',`ราคา $${fmt(price)} เข้า $${fmt(s.shortLow)}–$${fmt(s.shortHigh)}`,'eth-zone-s');
  }
  if(s.longLow&&price>=s.longLow&&price<=s.longHigh){
    showNotif('🟢 LONG ZONE!',`ราคา $${fmt(price)} เข้า $${fmt(s.longLow)}–$${fmt(s.longHigh)}`,'eth-zone-l');
  }
}

async function broadcastToTabs(msg){
  const all=await self.clients.matchAll({type:'window'});
  all.forEach(c=>c.postMessage(msg));
}

self.addEventListener('notificationclick', e=>{
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:'window'}).then(cs=>{
      if(cs.length>0)return cs[0].focus();
      return self.clients.openWindow('/Eth-cone-upp/');
    })
  );
});
