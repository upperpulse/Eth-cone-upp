// ETH Cone Bot v3.0 — Dashboard v5.19
// ⚠️ Rule: ทุกครั้งที่ update Dashboard ต้อง update version บรรทัดนี้ด้วย

const BOT_TOKEN = process.env.TG_TOKEN || '8397156356:AAHpIeQYWikPCH2wthqYBWMCMp0sXmFLcMM';
const CHAT_ID   = process.env.TG_CHAT  || '7970078364';
const BINANCE   = 'https://fapi.binance.com';
const FG_API    = 'https://api.alternative.me/fng/?limit=1';
const fs        = require('fs');
const http      = require('http');

// ── Config ────────────────────────────────
const AUTO_TRADE_TARGET = 10;   // รอบที่ต้องการ
const AUTO_DURATION_MS  = 7200000; // 2H
const AUTO_SIZE         = 100;  // $100
const ATR_MULT_TP1      = 1.0;  // TP1 = entry ± ATR*1.0
const ATR_MULT_TP2      = 2.0;  // TP2 = entry ± ATR*2.0
const ATR_MULT_SL       = 0.8;  // SL  = entry ∓ ATR*0.8

// ── State ─────────────────────────────────
let lastSig = '';
let lastConfAlert = false;
let goCooldown = 0;
let softGoCooldown = 0;
let fgCache = { val: 50, ts: 0 };
let tradeState = null;
let tradeInterval = null;
let autoTradeActive = false; // Auto Paper Trade running
let autoTrades = [];         // ผลทุกรอบ

// ── Telegram ──────────────────────────────
async function tg(msg, btn = false) {
  try {
    const body = { chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' };
    if (btn) body.reply_markup = { inline_keyboard: [[{ text: '📊 เปิด Dashboard', url: 'https://upperpulse.github.io/Eth-cone-upp/' }]] };
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) console.log('📲 TG sent:', msg.slice(0, 60));
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
function calcConf(macd,rsi,obv,btcMacd,fund,trap){let s=60;if(macd.positive)s+=8;if(macd.cross)s+=5;if(obv.positive)s+=5;if(obv.slope>0)s+=2;if(!obv.divergence)s+=2;if(btcMacd.positive)s+=8;if(rsi>40&&rsi<60)s+=3;if(rsi<38)s+=4;if(rsi>65)s-=4;if(rsi>62)s-=2;if(fund<-0.01)s+=2;if(fund>0.01)s-=2;if(trap.alert)s-=15;else if(trap.prob>0.3)s-=5;return Math.min(95,Math.max(50,Math.round(s)));}

// ── Auto Paper Trade ──────────────────────
async function startAutoPaperTrade(sig, price, dir, atr, conf, trigs) {
  if (autoTradeActive) return; // รอรอบเก่าจบก่อน
  autoTradeActive = true;

  const entry = price;
  const qty   = AUTO_SIZE / entry;
  const endTime = Date.now() + AUTO_DURATION_MS;

  let tp1, tp2, sl;
  if (dir === 'long') {
    tp1 = entry + atr * ATR_MULT_TP1;
    tp2 = entry + atr * ATR_MULT_TP2;
    sl  = entry - atr * ATR_MULT_SL;
  } else {
    tp1 = entry - atr * ATR_MULT_TP1;
    tp2 = entry - atr * ATR_MULT_TP2;
    sl  = entry + atr * ATR_MULT_SL;
  }

  const tradeNum = autoTrades.length + 1;
  const f = v => v.toFixed(2);

  await tg(
`🤖 <b>Auto Paper Trade #${tradeNum}/10</b>

🎯 Direction: <b>${dir.toUpperCase()}</b>
📊 Signal: ${sig}
📊 Conf: ${conf}% | Trig: ${trigs}/5
💰 Entry: $${f(entry)}
🎯 TP1: $${f(tp1)} | TP2: $${f(tp2)}
🛑 SL: $${f(sl)}
⏱ Duration: 2H`, true);

  // Monitor loop
  let tp1Hit = false;
  let maxP = 0, maxL = 0;

  const monitor = setInterval(async () => {
    const now = Date.now();
    let curPrice;
    try { curPrice = await fetchPrice(); } catch { return; }
    const p = parseFloat(curPrice);

    // track max profit/loss
    const pnlNow = dir === 'long' ? (p - entry) * qty : (entry - p) * qty;
    if (pnlNow > maxP) maxP = pnlNow;
    if (pnlNow < maxL) maxL = pnlNow;

    // Check timeout
    if (now >= endTime) {
      clearInterval(monitor);
      autoTradeActive = false;
      const pnl = dir === 'long' ? (p - entry) * qty : (entry - p) * qty;
      const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'TIMEOUT', maxP, maxL, conf };
      autoTrades.push(result);
      saveAutoTrades();
      await tg(`⏰ <b>Auto Trade #${tradeNum} TIMEOUT</b>\n\n${dir.toUpperCase()} Entry: $${f(entry)} → $${f(p)}\nPnL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\nMax Profit: +$${maxP.toFixed(2)} | Max Loss: $${maxL.toFixed(2)}`, true);
      if (autoTrades.length >= AUTO_TRADE_TARGET) await sendSummary();
      return;
    }

    if (dir === 'long') {
      if (!tp1Hit && p >= tp1) { tp1Hit = true; await tg(`🎯 Auto #${tradeNum} TP1 HIT $${f(p)}`, true); }
      if (p >= tp2) {
        clearInterval(monitor); autoTradeActive = false;
        const pnl = (p - entry) * qty;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'TP2', maxP, maxL, conf };
        autoTrades.push(result); saveAutoTrades();
        await tg(`🏆 <b>Auto Trade #${tradeNum} TP2 WIN!</b>\n\nLONG $${f(entry)} → $${f(p)}\n+$${pnl.toFixed(2)}`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET) await sendSummary();
      } else if (p <= sl) {
        clearInterval(monitor); autoTradeActive = false;
        const pnl = (p - entry) * qty;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'SL', maxP, maxL, conf };
        autoTrades.push(result); saveAutoTrades();
        await tg(`🛑 <b>Auto Trade #${tradeNum} SL HIT</b>\n\nLONG $${f(entry)} → $${f(p)}\n$${pnl.toFixed(2)}`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET) await sendSummary();
      }
    } else {
      if (!tp1Hit && p <= tp1) { tp1Hit = true; await tg(`🎯 Auto #${tradeNum} TP1 HIT $${f(p)}`, true); }
      if (p <= tp2) {
        clearInterval(monitor); autoTradeActive = false;
        const pnl = (entry - p) * qty;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'TP2', maxP, maxL, conf };
        autoTrades.push(result); saveAutoTrades();
        await tg(`🏆 <b>Auto Trade #${tradeNum} TP2 WIN!</b>\n\nSHORT $${f(entry)} → $${f(p)}\n+$${pnl.toFixed(2)}`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET) await sendSummary();
      } else if (p >= sl) {
        clearInterval(monitor); autoTradeActive = false;
        const pnl = (entry - p) * qty;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'SL', maxP, maxL, conf };
        autoTrades.push(result); saveAutoTrades();
        await tg(`🛑 <b>Auto Trade #${tradeNum} SL HIT</b>\n\nSHORT $${f(entry)} → $${f(p)}\n$${pnl.toFixed(2)}`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET) await sendSummary();
      }
    }
  }, 10000);
}

function saveAutoTrades() {
  try { fs.writeFileSync('/home/ubuntu/eth-bot/auto_trades.json', JSON.stringify(autoTrades, null, 2)); } catch {}
}

async function sendSummary() {
  const wins = autoTrades.filter(t => t.result === 'TP1' || t.result === 'TP2').length;
  const losses = autoTrades.filter(t => t.result === 'SL').length;
  const timeouts = autoTrades.filter(t => t.result === 'TIMEOUT').length;
  const totalPnL = autoTrades.reduce((a, t) => a + t.pnl, 0);
  const winRate = Math.round(wins / autoTrades.length * 100);

  let detail = '';
  autoTrades.forEach(t => {
    const icon = t.result === 'TP2' ? '🏆' : t.result === 'TP1' ? '🎯' : t.result === 'SL' ? '🛑' : '⏰';
    detail += `${icon} #${t.num} ${t.dir.toUpperCase()} ${t.result} ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}\n`;
  });

  await tg(
`📊 <b>Auto Paper Trade สรุป 10 รอบ</b>

✅ WIN: ${wins} | 🛑 LOSS: ${losses} | ⏰ TIMEOUT: ${timeouts}
📈 Win Rate: <b>${winRate}%</b>
💰 Total PnL: ${totalPnL>=0?'+':''}$${totalPnL.toFixed(2)}

${detail}
🔬 วิเคราะห์ผลกับ Claude ต่อได้เลย!`);
}

// ── Main Analysis ─────────────────────────
async function analyze() {
  try {
    if (tradeState) return;

    const [ethK,btcK,price,funding,fg] = await Promise.all([fetchKlines('ETHUSDT','1h',80),fetchKlines('BTCUSDT','1h',60),fetchPrice(),fetchFunding(),fetchFG()]);
    const ec=ethK.map(k=>parseFloat(k[4])),bc=btcK.map(k=>parseFloat(k[4]));
    const macd1h=calcMACD(ec),btcMacd=calcMACD(bc),rsi=calcRSI(ec,14),obv=calcOBV(ethK),atr=calcATR(ethK,14),trap=calcTrap(ethK,atr),btcBull=btcMacd.positive;
    const conf=calcConf(macd1h,rsi,obv,btcMacd,funding,trap),confOK=conf>=75;
    const trigsScore=[macd1h.cross||macd1h.positive,obv.positive&&obv.slope>0,btcBull,!trap.alert,fg>20&&fg<80].filter(Boolean).length;
    const rsiOS=rsi<38,rsiOB=rsi>62,rsiOK=(!rsiOB&&!rsiOS)||(rsiOS&&macd1h.positive)||(rsiOB&&!macd1h.positive);

    // ── Signal Logic (ปรับใหม่) ────────────
    // SOFT GO = Entry ได้เลย ไม่ต้องรอ MACD Cross
    let sig='HOLD';
    let entryReady = false;
    let entryDir = macd1h.positive ? 'long' : 'short';

    if(!confOK) sig=`HOLD — Conf ต่ำ (${conf}%)`;
    else if(trap.alert) sig='NO GO — TRAP DETECTED';
    else if(macd1h.positive && obv.positive && obv.slope>0 && btcBull && rsiOK) {
      sig = macd1h.cross ? 'GO' : 'SOFT GO — Entry Ready';
      entryReady = true;
    } else if(macd1h.positive && obv.positive && !btcBull) sig='HOLD — BTC ไม่ Align';
    else if(macd1h.positive && (!obv.positive||obv.slope<=0)) sig='HOLD — รอ OBV Slope+';
    else if(!macd1h.positive && obv.slope<0 && btcBull===false) {
      // SHORT setup
      sig = 'SOFT GO — SHORT Ready';
      entryDir = 'short';
      entryReady = confOK && !trap.alert;
    }
    else sig='HOLD — รอ Signal';

    const now=Date.now(),p=price.toFixed(2);
    const fgL=fg<=25?'😱 XFear':fg<=45?'😨 Fear':fg<=55?'😐 Neutral':fg<=75?'😊 Greed':'🤑 XGreed';
    console.log(`[${new Date().toLocaleTimeString('th-TH')}] $${p} Conf:${conf}% RSI:${rsi.toFixed(0)} Trig:${trigsScore}/5 | ${sig} ${autoTradeActive?'[AUTO TRADING]':''}`);

    // ── Auto Paper Trade trigger ───────────
    if(entryReady && !autoTradeActive && autoTrades.length < AUTO_TRADE_TARGET && sig !== lastSig) {
      await startAutoPaperTrade(sig, price, entryDir, atr, conf, trigsScore);
    }

    // ── Manual Notifications ───────────────
    if((sig==='GO'||sig==='SOFT GO — Entry Ready')&&sig!==lastSig&&now>goCooldown){
      goCooldown=now+180000;lastConfAlert=true;
      await tg(`${sig==='GO'?'✅':'⚡'} <b>ETH ${sig}</b>\n\n🎯 ${entryDir.toUpperCase()}\n📊 Conf: ${conf}% | Trig: ${trigsScore}/5\n💰 Price: $${p}\n📈 MACD: ${macd1h.cross?'Cross ✅':'Positive'} | OBV: ✅ | BTC: ✅\n📉 RSI: ${rsi.toFixed(1)}\n😨 F&G: ${fg} ${fgL}\n\n🤖 Auto Paper Trade #${autoTrades.length+1}/10 เริ่มแล้ว`,true);
    } else if(sig==='NO GO — TRAP DETECTED'&&sig!==lastSig){
      await tg(`⛔ <b>ETH TRAP</b>\n💰 $${p} | Trap: ${(trap.prob*100).toFixed(0)}%\n❌ งดเทรด`,true);
    }

    if(confOK&&!lastConfAlert&&!tradeState){
      lastConfAlert=true;
      await tg(`📊 <b>Confidence ≥ 75%!</b>\n\n🎯 ${macd1h.positive?'🟢 LONG':'🔴 SHORT'}\n📊 Conf: ${conf}% | Trig: ${trigsScore}/5\n💰 $${p} | RSI: ${rsi.toFixed(1)}\n😨 F&G: ${fg} ${fgL}\n\nระบบเริ่มตรวจ Trigger`,true);
    }
    lastSig=sig;
  } catch(e){console.error('Analyze error:',e.message);}
}

// ── Trade State File ──────────────────────
const TRADE_FILE='/home/ubuntu/eth-bot/.trade_state.json';
function saveTradeFile(s){try{fs.writeFileSync(TRADE_FILE,JSON.stringify(s));}catch{}}
function loadTradeFile(){try{if(!fs.existsSync(TRADE_FILE))return null;const s=JSON.parse(fs.readFileSync(TRADE_FILE,'utf8'));if(!s||!s.active||Date.now()>=s.endTime){fs.unlinkSync(TRADE_FILE);return null;}return s;}catch{return null;}}
function clearTradeFile(){try{if(fs.existsSync(TRADE_FILE))fs.unlinkSync(TRADE_FILE);}catch{}}

// ── Manual Trade Monitor ──────────────────
function stopTradeMonitor(){
  if(tradeInterval){clearInterval(tradeInterval);tradeInterval=null;}
  clearTradeFile();
  lastConfAlert=false;
}

function startTradeMonitor(state){
  stopTradeMonitor();
  tradeState=state;
  saveTradeFile({...state,active:true});
  goCooldown=Date.now()+120000;
  softGoCooldown=Date.now()+120000;
  lastConfAlert=true;
  console.log('📊 Manual Trade Monitor started');
  tg(`📊 <b>Trade Monitor เริ่มแล้ว!</b>\n\n🎯 ${state.dir.toUpperCase()}\n💰 Entry: $${parseFloat(state.entry).toFixed(2)}\n🎯 TP1: $${parseFloat(state.tp1).toFixed(2)} | TP2: $${parseFloat(state.tp2).toFixed(2)}\n🛑 SL: $${parseFloat(state.sl).toFixed(2)}\n⏱ ${state.dur}`,true);
  tradeInterval=setInterval(async()=>{
    if(!tradeState){stopTradeMonitor();return;}
    const now=Date.now();
    if(tradeState.endTime&&now>=tradeState.endTime){
      const price=await fetchPrice().catch(()=>tradeState.entry);
      const pnl=tradeState.dir==='long'?(price-tradeState.entry)*tradeState.qty:(tradeState.entry-price)*tradeState.qty;
      const tmp=tradeState;stopTradeMonitor();tradeState=null;
      await tg(`⏰ <b>TIMEOUT</b>\n🎯 ${tmp.dir.toUpperCase()} Entry: $${parseFloat(tmp.entry).toFixed(2)}\n💰 Exit: $${parseFloat(price).toFixed(2)}\nPnL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`,true);
      return;
    }
    let price;try{price=await fetchPrice();}catch{return;}
    const p=parseFloat(price),entry=parseFloat(tradeState.entry),tp1=parseFloat(tradeState.tp1),tp2=parseFloat(tradeState.tp2),sl=parseFloat(tradeState.sl),qty=parseFloat(tradeState.qty||0.04),f=v=>v.toFixed(2);
    if(tradeState.dir==='long'){
      if(!tradeState.tp1Hit&&p>=tp1){tradeState.tp1Hit=true;await tg(`🎯 <b>LONG TP1 HIT!</b>\n$${f(p)} | เหลือ ${Math.round((tradeState.endTime-now)/60000)} นาที`,true);}
      if(p>=tp2){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🏆 <b>LONG TP2 WIN!</b>\n$${f(p)} | +$${f((p-entry)*qty)}`,true);}
      else if(p<=sl){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🛑 <b>LONG SL HIT</b>\n$${f(p)} | -$${f((entry-p)*qty)}`,true);}
    }else{
      if(!tradeState.tp1Hit&&p<=tp1){tradeState.tp1Hit=true;await tg(`🎯 <b>SHORT TP1 HIT!</b>\n$${f(p)} | เหลือ ${Math.round((tradeState.endTime-now)/60000)} นาที`,true);}
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
    let body='';req.on('data',d=>body+=d);
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
    res.end(JSON.stringify({ok:true,trade:!!tradeState,autoTrade:autoTradeActive,autoCount:autoTrades.length,sig:lastSig}));
  }else if(req.method==='GET'&&req.url==='/auto-trades'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(autoTrades));
  }else{res.writeHead(404);res.end('Not found');}
});
server.listen(3000,()=>console.log('🌐 HTTP Server listening on port 3000'));

// ── Start ─────────────────────────────────
console.log('🚀 ETH Cone Bot v3.0 Started — Auto Paper Trade Mode');
console.log('📡 Monitoring every 10s | Singapore 🇸🇬');

// Load existing auto trades
try{const d=fs.readFileSync('/home/ubuntu/eth-bot/auto_trades.json','utf8');autoTrades=JSON.parse(d);console.log(`♻️ Loaded ${autoTrades.length} auto trades`);}catch{}

const savedTrade=loadTradeFile();
if(savedTrade){tradeState=savedTrade;startTradeMonitor(savedTrade);}

const flagFile='/home/ubuntu/eth-bot/.started';
if(!fs.existsSync(flagFile)){
  fs.writeFileSync(flagFile,Date.now().toString());
  tg(`🚀 <b>ETH Cone Bot v3.0 Online</b>\n\n🤖 Auto Paper Trade: ${autoTrades.length}/${AUTO_TRADE_TARGET} รอบ\n📡 Oracle Cloud 🇸🇬`);
}

analyze();
setInterval(analyze,10000);
