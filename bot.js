// ETH Cone Bot v3.13
// ⚠️ Rule: ทุกครั้งที่ update Dashboard ต้อง update version บรรทัดนี้ด้วย
// 🔗 Logic: ดึงจาก logic.js — แก้ที่ logic.js เท่านั้น

const BOT_VERSION = 'v3.13'; // ← แก้ที่นี่ที่เดียว
const DASH_VERSION = 'v5.21';

const BOT_TOKEN = process.env.TG_TOKEN || '';
const CHAT_ID   = process.env.TG_CHAT  || '';
const BINANCE   = 'https://fapi.binance.com';
const FG_API    = 'https://api.alternative.me/fng/?limit=1';
const fs        = require('fs');
const http      = require('http');
const path      = require('path');

// ── Load Logic from GitHub (ตอน startup เท่านั้น) ──
const LOGIC_URL  = 'https://raw.githubusercontent.com/upperpulse/Eth-cone-upp/main/logic.js';
const LOGIC_PATH = path.join(__dirname, 'logic.js');

let calcMACD, calcRSI, calcOBV, calcATR, calcTrap, calcConfidence, calcSignal, calcTriggers, calcBestDirection;

async function loadLogic() {
  try {
    const r = await fetch(LOGIC_URL);
    if (r.ok) {
      const code = await r.text();
      fs.writeFileSync(LOGIC_PATH, code);
      console.log('✅ logic.js loaded from GitHub');
    }
  } catch(e) {
    console.log('⚠️ GitHub unavailable, using local logic.js');
  }
  delete require.cache[require.resolve(LOGIC_PATH)];
  const logic = require(LOGIC_PATH);
  calcMACD = logic.calcMACD;
  calcRSI = logic.calcRSI;
  calcOBV = logic.calcOBV;
  calcATR = logic.calcATR;
  calcTrap = logic.calcTrap;
  calcConfidence = logic.calcConfidence;
  calcSignal = logic.calcSignal;
  calcTriggers = logic.calcTriggers;
  calcBestDirection = logic.calcBestDirection;
  console.log(`✅ Logic v${logic.version} ready`);
}

// ── Config ────────────────────────────────
const AUTO_TRADE_TARGET = 10;   // รอบที่ต้องการ (default)
let AUTO_TRADE_TARGET_DYNAMIC = 10; // ปรับได้จาก Dashboard
const AUTO_DURATION_MS  = 7200000; // 2H
const AUTO_SIZE         = 100;  // $100
const ATR_MULT_TP1      = 0.8;  // TP1 = entry ± ATR*0.8
const ATR_MULT_TP2      = 1.5;  // TP2 = entry ± ATR*1.5
const ATR_MULT_SL       = 1.5;  // SL  = entry ∓ ATR*1.5
const TRADE_COOLDOWN_MS = 1800000; // 30 นาที cooldown หลัง trade จบ

// ── State ─────────────────────────────────
let lastSig = '';
let lastConfAlert = false;
let goCooldown = 0;
let softGoCooldown = 0;
let fgCache = { val: 50, ts: 0 };
let tradeState = null;
let tradeInterval = null;
let autoTradeActive = false;
let lastTradeEndTime = 0; // cooldown หลัง trade จบ // Auto Paper Trade running
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


// ── Auto Paper Trade ──────────────────────
async function startAutoPaperTrade(sig, price, dir, atr, conf, trigs) {
  // autoTradeActive ถูก set ก่อน call แล้ว ไม่ต้อง check ซ้ำ
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

  try {
    await tg(
`🤖 <b>Auto Paper Trade #${tradeNum}/10</b>

🎯 Direction: <b>${dir.toUpperCase()}</b>
📊 Signal: ${sig}
📊 Conf: ${conf}% | Trig: ${trigs}/5
💰 Entry: $${f(entry)}
🎯 TP1: $${f(tp1)} | TP2: $${f(tp2)}
🛑 SL: $${f(sl)}
⏱ Duration: 1H`, true);
  } catch(e) { console.log('TG ERROR:', e.message); }

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
      lastTradeEndTime = Date.now(); // เริ่ม cooldown 30 นาที
      lastConfAlert = false;
      const pnl = dir === 'long' ? (p - entry) * qty : (entry - p) * qty;
      const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'TIMEOUT', maxP, maxL, conf };
      autoTrades.push(result);
      saveAutoTrades();
      await tg(`⏰ <b>Auto Trade #${tradeNum} TIMEOUT</b>\n\n${dir.toUpperCase()} Entry: $${f(entry)} → $${f(p)}\nPnL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\nMax Profit: +$${maxP.toFixed(2)} | Max Loss: $${maxL.toFixed(2)}`, true);
      if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      return;
    }

    if (dir === 'long') {
      if (!tp1Hit && p >= tp1) { tp1Hit = true; await tg(`🎯 Auto #${tradeNum} TP1 HIT $${f(p)}`, true); }
      if (p >= tp2) {
        clearInterval(monitor); autoTradeActive = false; lastTradeEndTime = Date.now(); lastConfAlert = false;
        const pnl = (p - entry) * qty;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'TP2', maxP, maxL, conf };
        autoTrades.push(result); saveAutoTrades();
        await tg(`🏆 <b>Auto Trade #${tradeNum} TP2 WIN!</b>\n\nLONG $${f(entry)} → $${f(p)}\n+$${pnl.toFixed(2)}`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      } else if (p <= sl) {
        clearInterval(monitor); autoTradeActive = false; lastTradeEndTime = Date.now(); lastConfAlert = false;
        const pnl = (p - entry) * qty;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'SL', maxP, maxL, conf };
        autoTrades.push(result); saveAutoTrades();
        await tg(`🛑 <b>Auto Trade #${tradeNum} SL HIT</b>\n\nLONG $${f(entry)} → $${f(p)}\n$${pnl.toFixed(2)}`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      }
    } else {
      if (!tp1Hit && p <= tp1) { tp1Hit = true; await tg(`🎯 Auto #${tradeNum} TP1 HIT $${f(p)}`, true); }
      if (p <= tp2) {
        clearInterval(monitor); autoTradeActive = false; lastTradeEndTime = Date.now(); lastConfAlert = false;
        const pnl = (entry - p) * qty;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'TP2', maxP, maxL, conf };
        autoTrades.push(result); saveAutoTrades();
        await tg(`🏆 <b>Auto Trade #${tradeNum} TP2 WIN!</b>\n\nSHORT $${f(entry)} → $${f(p)}\n+$${pnl.toFixed(2)}`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      } else if (p >= sl) {
        clearInterval(monitor); autoTradeActive = false; lastTradeEndTime = Date.now(); lastConfAlert = false;
        const pnl = (entry - p) * qty;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, result: 'SL', maxP, maxL, conf };
        autoTrades.push(result); saveAutoTrades();
        await tg(`🛑 <b>Auto Trade #${tradeNum} SL HIT</b>\n\nSHORT $${f(entry)} → $${f(p)}\n$${pnl.toFixed(2)}`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      }
    }
  }, 10000);
}

function saveAutoTrades() {
  try { fs.writeFileSync('/home/ubuntu/eth-bot/auto_trades.json', JSON.stringify(autoTrades, null, 2)); } catch {}
}

async function sendSummary() {
  const wins = autoTrades.filter(t => 
    t.result === 'TP1' || t.result === 'TP2' || 
    (t.result === 'TIMEOUT' && t.pnl > 0)
  ).length;
  const losses = autoTrades.filter(t => 
    t.result === 'SL' || 
    (t.result === 'TIMEOUT' && t.pnl <= 0)
  ).length;
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
    // คำนวณ trap ก่อน แล้วส่งเข้า calcBestDirection
    const atrTemp = calcATR(ethK, 14);
    const trapTemp = calcTrap(ethK, atrTemp);
    // ── เปรียบเทียบทั้งสองฝั่ง เลือก Conf สูงกว่า ──
    const best    = calcBestDirection(ethK, btcK, funding, trapTemp, fg);
    const macd1h  = best.macd;
    const btcMacd = best.btcMacd;
    const rsi     = best.rsi;
    const obv     = best.obv;
    const atr     = best.atr;
    const trap2   = best.trap;
    const btcBull = btcMacd.positive;
    const conf    = best.confLong >= best.confShort ? best.confLong : best.confShort;
    const trigs   = calcTriggers(macd1h, obv, btcBull, trap2, fg);
    const sig     = best.best ? best.best.sig : best.sigLong.sig;
    const entryReady = best.best ? best.best.entryReady : false;
    const entryDir   = best.best ? best.best.entryDir : 'long';
    const emaDir  = best.aboveEMA50 ? '↑EMA' : '↓EMA';

    const now=Date.now(),p=price.toFixed(2);
    const fgL=fg<=25?'😱 XFear':fg<=45?'😨 Fear':fg<=55?'😐 Neutral':fg<=75?'😊 Greed':'🤑 XGreed';
    console.log(`[${new Date().toLocaleTimeString('th-TH')}] $${p} Conf:${conf}% RSI:${rsi.toFixed(0)} ${emaDir} ATR:${best.atrOK?'✓':'✗'} | ${sig} ${autoTradeActive?'[AUTO TRADING]':''}`);

    // ── Auto Paper Trade trigger ───────────
    const cooldownOK = Date.now() > lastTradeEndTime + TRADE_COOLDOWN_MS;
    if(entryReady && !autoTradeActive && autoTrades.length < AUTO_TRADE_TARGET_DYNAMIC && cooldownOK) {
      autoTradeActive = true;
      lastConfAlert = true;
      await startAutoPaperTrade(sig, price, entryDir, atr, conf, trigs.score);
    } else if(!cooldownOK) {
      const remain = Math.round((lastTradeEndTime + TRADE_COOLDOWN_MS - Date.now())/60000);
      if(remain > 0) console.log(`[COOLDOWN] รอ ${remain} นาที`);
    }

    // ── Manual Notifications ───────────────
    if((sig==='GO'||sig==='SOFT GO — Entry Ready')&&sig!==lastSig&&now>goCooldown){
      goCooldown=now+7200000;lastConfAlert=true;
      await tg(`${sig==='GO'?'✅':'⚡'} <b>ETH ${sig}</b>\n\n🎯 ${entryDir.toUpperCase()}\n📊 Conf: ${conf}% | Trig: ${trigs.score}/5\n💰 Price: $${p}\n📈 MACD: ${macd1h.cross?'Cross ✅':'Positive'} | OBV: ✅ | BTC: ✅\n📉 RSI: ${rsi.toFixed(1)}\n😨 F&G: ${fg} ${fgL}\n\n🤖 Auto Paper Trade #${autoTrades.length+1}/10 เริ่มแล้ว`,true);
    } else if(sig==='NO GO — TRAP DETECTED'&&sig!==lastSig){
      await tg(`⛔ <b>ETH TRAP</b>\n💰 $${p} | Trap: ${(trap.prob*100).toFixed(0)}%\n❌ งดเทรด`,true);
    }

    if(conf>=75&&!lastConfAlert&&!tradeState){
      lastConfAlert=true;
      await tg(`📊 <b>Confidence ≥ 75%!</b>\n\n🎯 ${macd1h.positive?'🟢 LONG':'🔴 SHORT'}\n📊 Conf: ${conf}% | Trig: ${trigs.score}/5\n💰 $${p} | RSI: ${rsi.toFixed(1)}\n😨 F&G: ${fg} ${fgL}\n\nระบบเริ่มตรวจ Trigger`,true);
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
        else if(state.action==='stop'){
          stopTradeMonitor();tradeState=null;
          autoTradeActive=false;
          lastConfAlert=false;
          res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));
        }
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
console.log(`🚀 ETH Cone Bot ${BOT_VERSION} Started — Auto Paper Trade Mode`);
console.log('📡 Monitoring every 10s | Singapore 🇸🇬');

(async () => {
  // โหลด logic.js จาก GitHub ก่อน start
  await loadLogic();

  // Load existing auto trades
  try{const d=fs.readFileSync('/home/ubuntu/eth-bot/auto_trades.json','utf8');autoTrades=JSON.parse(d);console.log(`♻️ Loaded ${autoTrades.length} auto trades`);}catch{}

  const savedTrade=loadTradeFile();
  if(savedTrade){tradeState=savedTrade;startTradeMonitor(savedTrade);}

  const flagFile='/home/ubuntu/eth-bot/.started';
  if(!fs.existsSync(flagFile)){
    fs.writeFileSync(flagFile,Date.now().toString());
    tg(`🚀 <b>ETH Cone Bot ${BOT_VERSION} Online</b>\n\n🤖 Auto Paper Trade: ${autoTrades.length}/${AUTO_TRADE_TARGET} รอบ\n📡 Oracle Cloud 🇸🇬`);
  }

  let analyzing = false;
  analyze();
  setInterval(async () => {
    if (analyzing) return;
    analyzing = true;
    await analyze();
    analyzing = false;
  }, 10000);
})();
