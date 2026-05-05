// ETH Cone Bot v3.0 — Dashboard v5.19
// ⚠️ Rule: ทุกครั้งที่ update Dashboard ต้อง update version บรรทัดนี้ด้วย

const BOT_TOKEN = process.env.TG_TOKEN || '8397156356:AAHpIeQYWikPCH2wthqYBWMCMp0sXmFLcMM';
const CHAT_ID   = process.env.TG_CHAT  || '7970078364';
const BINANCE   = 'https://fapi.binance.com';
const FG_API    = 'https://api.alternative.me/fng/?limit=1';
const fs        = require('fs');
const http      = require('http');

// ── State (declare ก่อน analyze) ─────────
let lastSig = '';
let lastConfAlert = false;
let goCooldown = 0;
let softGoCooldown = 0;
let fgCache = { val: 50, ts: 0 };
let tradeState = null;
let tradeInterval = null;

// ── Telegram ──────────────────────────────
async function tg(msg, btn = false) {
  try {
    const body = { chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' };
    if (btn) body.reply_markup = { inline_keyboard: [[{ text: '📊 เปิด Dashboard', url: 'https://upperpulse.github.io/Eth-cone-upp/' }]] };
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) console.log('📲 TG sent:', msg.slice(0, 50));
    else console.error('TG Error:', d.description);
  } catch (e) { console.error('TG:', e.message); }
}

// ── Fetch ─────────────────────────────────
async function fetchKlines(sym, iv, lim) { const r = await fetch(`${BINANCE}/fapi/v1/klines?symbol=${sym}&interval=${iv}&limit=${lim}`); return r.json(); }
async function fetchPrice() { const r = await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=ETHUSDT`); const d = await r.json(); return parseFloat(d.price); }
async function fetchFunding() { try { const r = await fetch(`${BINANCE}/fapi/v1/premiumIndex?symbol=ETHUSDT`); const d = await r.json(); return parseFloat(d.lastFundingRate)*100; } catch { return 0; } }
async function fetchFG() {
  if (Date.now() - fgCache.ts < 6*3600*1000) return fgCache.val;
  try { const r = await fetch(FG_API); const d = await r.json(); const val = parseInt(d.data[0].value); fgCache = {val,ts:Date.now()}; return val; } catch { return fgCache.val; }
}

// ── Indicators ────────────────────────────
function calcEMA(c,n){const k=2/(n+1);let e=c[0];for(let i=1;i<c.length;i++)e=c[i]*k+e*(1-k);return e;}
function calcMACD(c){const h=calcEMA(c,12)-calcEMA(c,26),ph=calcEMA(c.slice(0,-1),12)-calcEMA(c.slice(0,-1),26);return{positive:h>0,cross:h>0&&ph<=0,hist:h};}
function calcRSI(c,p=14){if(c.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}return al===0?100:100-100/(1+ag/al);}
function calcOBV(k){let o=0;const a=[0];for(let i=1;i<k.length;i++){const c=parseFloat(k[i][4]),pc=parseFloat(k[i-1][4]),v=parseFloat(k[i][5]);o+=c>pc?v:c<pc?-v:0;a.push(o);}const r=a.slice(-10);return{positive:o>0,slope:(r[r.length-1]-r[0])/10,divergence:r.slice(-3).every((v,i,a)=>i===0||v<a[i-1])};}
function calcATR(k,p=14){const t=[];for(let i=1;i<k.length;i++){const h=parseFloat(k[i][2]),l=parseFloat(k[i][3]),pc=parseFloat(k[i-1][4]);t.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}return t.slice(-p).reduce((a,b)=>a+b,0)/p;}
function calcTrap(k,atr){const h=k.map(x=>parseFloat(x[2])),l=k.map(x=>parseFloat(x[3])),v=k.map(x=>parseFloat(x[5]));const last=k[k.length-1],body=Math.abs(parseFloat(last[4])-parseFloat(last[1])),range=parseFloat(last[2])-parseFloat(last[3]),wickR=range>0?(range-body)/range:0,avg=v.slice(-20).reduce((a,b)=>a+b,0)/20,std=Math.sqrt(v.slice(-20).reduce((a,b)=>a+Math.pow(b-avg,2),0)/20),volZ=std>0?(v[v.length-1]-avg)/std:0,sq=(Math.max(...h.slice(-5))-Math.min(...l.slice(-5)))<atr*0.5;let prob=0;if(wickR>0.6)prob+=0.3;if(volZ>2)prob+=0.25;if(sq)prob+=0.3;if(volZ<-1)prob+=0.15;return{prob:Math.min(1,prob),alert:prob>0.6};}
function calcConf(macd,rsi,obv,btcMacd,fund,trap){let s=60;if(macd.positive)s+=8;if(macd.cross)s+=5;if(obv.positive)s+=7;if(obv.slope>0)s+=3;if(!obv.divergence)s+=2;if(btcMacd.positive)s+=8;if(rsi>40&&rsi<60)s+=3;if(rsi<38)s+=4;if(rsi>65)s-=4;if(rsi>62)s-=2;if(fund<-0.01)s+=2;if(fund>0.01)s-=2;if(trap.alert)s-=15;else if(trap.prob>0.3)s-=5;return Math.min(95,Math.max(50,Math.round(s)));}
function checkTrigs(macd,obv,btcBull,trap,fg){const t1=macd.cross||macd.positive,t2=obv.positive&&obv.slope>0,t3=btcBull,t4=!trap.alert,t5=fg>20&&fg<80;return{score:[t1,t2,t3,t4,t5].filter(Boolean).length};}

// ── Main Analysis ─────────────────────────
async function analyze() {
  try {
    if (tradeState) return; // ไม่ check อะไรเลยถ้า trade รัน
    const [ethK,btcK,price,funding,fg] = await Promise.all([fetchKlines('ETHUSDT','1h',80),fetchKlines('BTCUSDT','1h',60),fetchPrice(),fetchFunding(),fetchFG()]);
    const ec=ethK.map(k=>parseFloat(k[4])),bc=btcK.map(k=>parseFloat(k[4]));
    const macd1h=calcMACD(ec),btcMacd=calcMACD(bc),rsi=calcRSI(ec,14),obv=calcOBV(ethK),atr=calcATR(ethK,14),trap=calcTrap(ethK,atr),btcBull=btcMacd.positive;
    const conf=calcConf(macd1h,rsi,obv,btcMacd,funding,trap),trigs=checkTrigs(macd1h,obv,btcBull,trap,fg),confOK=conf>=75;
    const rsiOS=rsi<38,rsiOB=rsi>62,rsiOK=(!rsiOB&&!rsiOS)||(rsiOS&&macd1h.positive)||(rsiOB&&!macd1h.positive);
    let sig='HOLD';
    if(!confOK)sig=`HOLD — Conf ต่ำ (${conf}%)`;
    else if(trap.alert)sig='NO GO — TRAP DETECTED';
    else if(macd1h.cross&&obv.positive&&obv.slope>0&&btcBull&&rsiOK)sig='GO';
    else if(macd1h.positive&&obv.positive&&obv.slope>0&&btcBull)sig='SOFT GO — รอ MACD Cross';
    else if(macd1h.positive&&obv.positive&&!btcBull)sig='HOLD — BTC ไม่ Align';
    else if(macd1h.positive&&(!obv.positive||obv.slope<=0))sig='HOLD — รอ OBV Slope+';
    else if(!macd1h.positive&&macd1h.cross)sig='WATCH — MACD Cross เพิ่งเกิด';
    else sig='HOLD — MACD ยังไม่ Cross';
    const dir=macd1h.positive?'LONG 🟢':'SHORT 🔴',now=Date.now(),p=price.toFixed(2);
    const fgL=fg<=25?'😱 Extreme Fear':fg<=45?'😨 Fear':fg<=55?'😐 Neutral':fg<=75?'😊 Greed':'🤑 Extreme Greed';
    console.log(`[${new Date().toLocaleTimeString('th-TH')}] $${p} Conf:${conf}% RSI:${rsi.toFixed(0)} Trig:${trigs.score}/5 | ${sig}`);

    if(sig==='GO'&&sig!==lastSig&&now>goCooldown){
      goCooldown=now+180000;lastConfAlert=true;
      await tg(`✅ <b>ETH GO SIGNAL!</b>\n\n🎯 Direction: <b>${dir}</b>\n📊 Confidence: <b>${conf}%</b>\n⚡ Trigger: <b>${trigs.score}/5</b>\n💰 Price: <b>$${p}</b>\n📈 MACD Cross: ✅ OBV Slope+: ✅ BTC: ✅\n📉 RSI: ${rsi.toFixed(1)} ${rsiOS?'📉OS':rsiOB?'📈OB':'✅'}\n😨 F&G: ${fg} ${fgL}\n💸 Funding: ${funding.toFixed(4)}%`,true);
    } else if(sig==='SOFT GO — รอ MACD Cross'&&sig!==lastSig&&now>softGoCooldown){
      softGoCooldown=now+120000;lastConfAlert=true;
      await tg(`⚡ <b>ETH SOFT GO</b>\n\n🎯 Direction: <b>${macd1h.positive?'🟢 LONG':'🔴 SHORT'}</b>\n📊 Conf: <b>${conf}%</b> | Trig: <b>${trigs.score}/5</b>\n💰 Price: $${p}\n📈 MACD: Positive (รอ Cross)\n📊 OBV: ${obv.positive&&obv.slope>0?'✅':'❌'} BTC: ${btcBull?'✅':'❌'}\n📉 RSI: ${rsi.toFixed(1)} 😨 F&G: ${fg} ${fgL}\n\n⏳ รอ MACD Cross ก่อน Entry`,true);
    } else if(sig==='NO GO — TRAP DETECTED'&&sig!==lastSig){
      await tg(`⛔ <b>ETH TRAP DETECTED</b>\n\n💰 Price: $${p}\n🪤 Trap: ${(trap.prob*100).toFixed(0)}% | Conf: ${conf}%\n\n❌ งดเทรด`,true);
    }
    // Conf alert — ส่งครั้งเดียว reset เมื่อ trade จบ
    if(confOK&&!lastConfAlert&&!tradeState){
      lastConfAlert=true;
      await tg(`📊 <b>Confidence ≥ 75%!</b>\n\n🎯 Direction: <b>${macd1h.positive?'🟢 LONG':'🔴 SHORT'}</b>\n📊 Conf: ${conf}% | Trig: ${trigs.score}/5\n💰 Price: $${p} | RSI: ${rsi.toFixed(1)}\n😨 F&G: ${fg} ${fgL}\n\nระบบเริ่มตรวจ Trigger แล้ว`,true);
    }
    lastSig=sig;
  } catch(e){console.error('Analyze error:',e.message);}
}

// ── Trade State File ──────────────────────
const TRADE_FILE='/home/ubuntu/eth-bot/.trade_state.json';
function saveTradeFile(s){try{fs.writeFileSync(TRADE_FILE,JSON.stringify(s));}catch{}}
function loadTradeFile(){try{if(!fs.existsSync(TRADE_FILE))return null;const s=JSON.parse(fs.readFileSync(TRADE_FILE,'utf8'));if(!s||!s.active||Date.now()>=s.endTime){fs.unlinkSync(TRADE_FILE);return null;}return s;}catch{return null;}}
function clearTradeFile(){try{if(fs.existsSync(TRADE_FILE))fs.unlinkSync(TRADE_FILE);}catch{}}

// ── Trade Monitor ─────────────────────────
function stopTradeMonitor(){
  if(tradeInterval){clearInterval(tradeInterval);tradeInterval=null;}
  clearTradeFile();
  lastConfAlert=false; // reset หลัง trade จบ — พร้อม alert รอบใหม่
}

function startTradeMonitor(state){
  stopTradeMonitor();
  tradeState=state;
  saveTradeFile({...state,active:true});
  goCooldown=Date.now()+120000;
  softGoCooldown=Date.now()+120000;
  lastConfAlert=true;
  console.log('📊 Trade Monitor started');
  tg(`📊 <b>Trade Monitor เริ่มแล้ว!</b>\n\n🎯 Direction: ${state.dir.toUpperCase()}\n💰 Entry: $${parseFloat(state.entry).toFixed(2)}\n🎯 TP1: $${parseFloat(state.tp1).toFixed(2)}\n🏆 TP2: $${parseFloat(state.tp2).toFixed(2)}\n🛑 SL: $${parseFloat(state.sl).toFixed(2)}\n⏱ Duration: ${state.dur}\n\nBot จะแจ้งเมื่อ TP/SL/Timeout`,true);
  tradeInterval=setInterval(async()=>{
    if(!tradeState){stopTradeMonitor();return;}
    const now=Date.now();
    if(tradeState.endTime&&now>=tradeState.endTime){
      const price=await fetchPrice().catch(()=>tradeState.entry);
      const pnl=tradeState.dir==='long'?(price-tradeState.entry)*tradeState.qty:(tradeState.entry-price)*tradeState.qty;
      const tmp=tradeState;stopTradeMonitor();tradeState=null;
      await tg(`⏰ <b>Trade TIMEOUT</b>\n\n🎯 ${tmp.dir.toUpperCase()} | Entry: $${parseFloat(tmp.entry).toFixed(2)}\n💰 Exit: $${parseFloat(price).toFixed(2)}\n📊 PnL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`,true);
      return;
    }
    let price;try{price=await fetchPrice();}catch{return;}
    const p=parseFloat(price),entry=parseFloat(tradeState.entry),tp1=parseFloat(tradeState.tp1),tp2=parseFloat(tradeState.tp2),sl=parseFloat(tradeState.sl),qty=parseFloat(tradeState.qty||0.04),f=v=>v.toFixed(2);
    if(tradeState.dir==='long'){
      if(!tradeState.tp1Hit&&p>=tp1){tradeState.tp1Hit=true;await tg(`🎯 <b>LONG TP1 HIT!</b>\n$${f(p)} ≥ $${f(tp1)} | เหลือ ${Math.round((tradeState.endTime-now)/60000)} นาที`,true);}
      if(p>=tp2){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🏆 <b>LONG TP2 WIN!</b>\n$${f(p)} | +$${f((p-entry)*qty)}`,true);}
      else if(p<=sl){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🛑 <b>LONG SL HIT</b>\n$${f(p)} | -$${f((entry-p)*qty)}`,true);}
    }else{
      if(!tradeState.tp1Hit&&p<=tp1){tradeState.tp1Hit=true;await tg(`🎯 <b>SHORT TP1 HIT!</b>\n$${f(p)} ≤ $${f(tp1)} | เหลือ ${Math.round((tradeState.endTime-now)/60000)} นาที`,true);}
      if(p<=tp2){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🏆 <b>SHORT TP2 WIN!</b>\n$${f(p)} | +$${f((entry-p)*qty)}`,true);}
      else if(p>=sl){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🛑 <b>SHORT SL HIT</b>\n$${f(p)} | -$${f((p-entry)*qty)}`,true);}
    }
  },10000);
}

// ── HTTP Server ───────────────────────────
const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS,GET');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,ngrok-skip-browser-warning,User-Agent');
  res.setHeader('ngrok-skip-browser-warning','true');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}
  if(req.method==='POST'&&req.url==='/trade'){
    let body='';
    req.on('data',d=>body+=d);
    req.on('end',()=>{
      try{
        const state=JSON.parse(body);
        if(state.action==='start'){startTradeMonitor(state);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}
        else if(state.action==='stop'){stopTradeMonitor();tradeState=null;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}
        else{res.writeHead(400);res.end('Unknown action');}
      }catch(e){res.writeHead(400);res.end('Invalid JSON');}
    });
  }else if(req.method==='GET'&&req.url==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,trade:!!tradeState,sig:lastSig}));
  }else{res.writeHead(404);res.end('Not found');}
});
server.listen(3000,()=>console.log('🌐 HTTP Server listening on port 3000'));

// ── Start ─────────────────────────────────
console.log('🚀 ETH Cone Bot v3.0 Started');
console.log('📡 Monitoring every 10s | Singapore 🇸🇬');

// Restore trade state หลัง reboot
const savedTrade=loadTradeFile();
if(savedTrade){tradeState=savedTrade;startTradeMonitor(savedTrade);console.log('♻️ Restored trade state');tg(`♻️ <b>Restore Trade หลัง Reboot</b>\n🎯 ${savedTrade.dir.toUpperCase()} Entry: $${parseFloat(savedTrade.entry).toFixed(2)}\nเหลือ ${Math.max(0,Math.round((savedTrade.endTime-Date.now())/60000))} นาที`,true);}

// Startup message ครั้งแรกเท่านั้น
const flagFile='/home/ubuntu/eth-bot/.started';
if(!fs.existsSync(flagFile)){fs.writeFileSync(flagFile,Date.now().toString());tg('🚀 <b>ETH Cone Bot v3.0 Online</b> | Oracle 🇸🇬');}

analyze();
setInterval(analyze,10000);
