// ═══════════════════════════════════════════════════════════
//  binance-live.js v3 — Multi-Symbol + Auto Stop-API Detection
//  รองรับทั้ง STOP_MARKET ปกติ (mainnet) และ Algo API (testnet demo)
//  ตรวจเองว่า environment รองรับแบบไหน แล้วจำไว้
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');

const LIVE_MODE   = process.env.LIVE_MODE === 'true';
const USE_TESTNET = process.env.USE_TESTNET !== 'false';
const API_KEY     = process.env.BINANCE_KEY || '';
const API_SECRET  = process.env.BINANCE_SECRET || '';
const LEVERAGE    = parseInt(process.env.LEVERAGE || '3');

const BASE = USE_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
let enabled = !!(LIVE_MODE && API_KEY && API_SECRET);

// SL order ที่คุมอยู่ต่อเหรียญ: { id, isAlgo }
const lastStop = {};
const staleStops = {};   // symbol ที่เคยลบ SL ไม่สำเร็จ → ต้องกวาดรอบหน้า
// โหมด stop order: 'unknown' → ตรวจครั้งแรก → 'standard' | 'algo'
let stopMode = 'unknown';

const QTY_PRECISION   = { ETHUSDT: 3, SOLUSDT: 0, BTCUSDT: 3 };
const PRICE_PRECISION = { ETHUSDT: 2, SOLUSDT: 4, BTCUSDT: 1 };
const qStep = s => QTY_PRECISION[s] ?? 3;
const pStep = s => PRICE_PRECISION[s] ?? 2;

function isEnabled() { return enabled; }
function stopApiMode() { return stopMode; }
function modeLabel() {
  if (!LIVE_MODE) return 'PAPER';
  if (!API_KEY || !API_SECRET) return 'PAPER (ไม่มี key)';
  return USE_TESTNET ? 'LIVE-TESTNET' : 'LIVE-MAINNET';
}
function sign(q) { return crypto.createHmac('sha256', API_SECRET).update(q).digest('hex'); }

async function raw(method, path, params = {}) {
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  const url = `${BASE}${path}?${query}&signature=${sign(query)}`;
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
  return res.json();
}
async function binanceRequest(method, path, params = {}) {
  if (!enabled) throw new Error('Live mode disabled');
  const data = await raw(method, path, params);
  if (data && data.code && Number(data.code) < 0) throw new Error(`Binance ${data.code}: ${data.msg}`);
  return data;
}

// ── LEVERAGE ──
async function setLeverage(symbols = ['ETHUSDT', 'SOLUSDT']) {
  if (!enabled) return;
  for (const symbol of symbols) {
    try {
      await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: LEVERAGE });
      console.log(`[LIVE] ${symbol} leverage ${LEVERAGE}x`);
    } catch (e) { console.error(`[LIVE] setLeverage ${symbol}:`, e.message); }
  }
}

// ── MARKET ORDER (ใช้ endpoint ปกติเสมอ) ──
async function placeMarketOrder(symbol, side, qty, reduceOnly = false) {
  if (!enabled) return { simulated: true, symbol, side, qty };
  const params = { symbol, side, type: 'MARKET', quantity: qty.toFixed(qStep(symbol)) };
  if (reduceOnly) params.reduceOnly = 'true';
  const order = await binanceRequest('POST', '/fapi/v1/order', params);
  console.log(`[LIVE] ${symbol} MARKET ${side} ${qty.toFixed(qStep(symbol))} → ${order.orderId}`);
  return order;
}

// ══════════ STOP ORDER — ตรวจเองว่าใช้ API แบบไหน ══════════
async function placeStopStandard(symbol, side, qty, stopPrice) {
  const data = await raw('POST', '/fapi/v1/order', {
    symbol, side, type: 'STOP_MARKET',
    quantity: qty.toFixed(qStep(symbol)),
    stopPrice: stopPrice.toFixed(pStep(symbol)),
    reduceOnly: 'true'
  });
  if (data && data.code && Number(data.code) < 0) {
    const err = new Error(`Binance ${data.code}: ${data.msg}`);
    err.code = Number(data.code);
    throw err;
  }
  return { id: data.orderId, isAlgo: false, raw: data };
}

async function placeStopAlgo(symbol, side, qty, stopPrice) {
  const data = await raw('POST', '/fapi/v1/algoOrder', {
    symbol, side,
    algoType: 'CONDITIONAL', type: 'STOP_MARKET',
    triggerPrice: stopPrice.toFixed(pStep(symbol)),
    quantity: qty.toFixed(qStep(symbol)),
    reduceOnly: 'true'
  });
  if (!data || !data.algoId) {
    throw new Error(`Algo ${data && data.code}: ${data && data.msg}`);
  }
  return { id: data.algoId, isAlgo: true, raw: data };
}

async function placeStopOrder(symbol, side, qty, stopPrice) {
  if (!enabled) return { simulated: true, symbol, side, stopPrice };
  let result;
  if (stopMode === 'algo') {
    result = await placeStopAlgo(symbol, side, qty, stopPrice);
  } else if (stopMode === 'standard') {
    result = await placeStopStandard(symbol, side, qty, stopPrice);
  } else {
    // ยังไม่รู้ → ลองแบบมาตรฐานก่อน ถ้าเจอ -4120 ค่อยใช้ algo
    try {
      result = await placeStopStandard(symbol, side, qty, stopPrice);
      stopMode = 'standard';
      console.log('[LIVE] stop API = STANDARD (/fapi/v1/order)');
    } catch (e) {
      if (e.code === -4120 || /Algo Order API/i.test(e.message)) {
        result = await placeStopAlgo(symbol, side, qty, stopPrice);
        stopMode = 'algo';
        console.log('[LIVE] stop API = ALGO (/fapi/v1/algoOrder)');
      } else throw e;
    }
  }
  lastStop[symbol] = { id: result.id, isAlgo: result.isAlgo };
  console.log(`[LIVE] ${symbol} STOP ${side} @ ${stopPrice.toFixed(pStep(symbol))} → ${result.isAlgo ? 'algoId' : 'orderId'} ${result.id}`);
  return { orderId: result.id, algoId: result.isAlgo ? result.id : undefined, isAlgo: result.isAlgo };
}

// คืน true = ลบสำเร็จ (หรือไม่มีอยู่แล้ว), false = ลบไม่ได้
async function cancelStop(symbol, ref) {
  if (!enabled || !ref) return true;
  const id = typeof ref === 'object' ? ref.id : ref;
  const isAlgo = typeof ref === 'object' ? ref.isAlgo : (stopMode === 'algo');
  try {
    if (isAlgo) await binanceRequest('DELETE', '/fapi/v1/algoOrder', { symbol, algoId: id });
    else await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: id });
    console.log(`[LIVE] ${symbol} cancelled stop ${id}`);
    return true;
  } catch (e) {
    // -2011 Unknown order = ไม่มีอยู่แล้ว ถือว่าสำเร็จ
    if (/-2011|Unknown order/i.test(e.message)) return true;
    console.log(`[LIVE] ${symbol} cancel ${id} ล้มเหลว: ${e.message}`);
    return false;
  }
}

// กวาด stop order ส่วนเกินให้เหลือแค่ keepId (หรือลบหมดถ้า keepId=null)
// ป้องกัน order สะสมจาก trail ที่ลบไม่สำเร็จ
async function sweepStops(symbol, keepId = null) {
  if (!enabled) return { removed: 0, remaining: 0 };
  const stops = (await getOpenStops(symbol)).filter(o => o.symbol === symbol);
  let removed = 0;
  for (const o of stops) {
    if (keepId && String(o.id) === String(keepId)) continue;
    if (await cancelStop(symbol, o)) removed++;
  }
  const after = (await getOpenStops(symbol)).filter(o => o.symbol === symbol);
  if (removed) console.log(`[LIVE] ${symbol} กวาด SL ส่วนเกิน ${removed} อัน (เหลือ ${after.length})`);
  return { removed, remaining: after.length };
}
const cancelOrder = (symbol, orderId) => cancelStop(symbol, orderId);

// ── ดู stop order ที่เปิดอยู่ (รวมทั้ง 2 แบบ) ──
async function getOpenStops(symbol) {
  if (!enabled) return [];
  const out = [];
  try {
    const algo = await raw('GET', '/fapi/v1/openAlgoOrders', symbol ? { symbol } : {});
    if (Array.isArray(algo)) {
      algo.filter(o => o.orderType === 'STOP_MARKET' || o.algoType === 'CONDITIONAL')
          .forEach(o => out.push({
            id: o.algoId, isAlgo: true, symbol: o.symbol, side: o.side,
            stopPrice: parseFloat(o.triggerPrice || o.stopPrice || 0),
            qty: parseFloat(o.quantity), updateTime: o.bookTime || o.updateTime || 0
          }));
    }
  } catch (e) {}
  try {
    const std = await raw('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {});
    if (Array.isArray(std)) {
      std.filter(o => o.type === 'STOP_MARKET' || o.type === 'STOP')
         .forEach(o => out.push({
           id: o.orderId, isAlgo: false, symbol: o.symbol, side: o.side,
           stopPrice: parseFloat(o.stopPrice), qty: parseFloat(o.origQty),
           updateTime: o.updateTime || 0
         }));
    }
  } catch (e) {}
  return out;
}
const getOpenOrders = getOpenStops;

// ── รับช่วง SL ที่มีอยู่ตอน restart + ลบตัวซ้ำ ──
async function adoptStopOrders(symbols = []) {
  if (!enabled) return {};
  const adopted = {};
  for (const symbol of symbols) {
    const stops = (await getOpenStops(symbol)).filter(o => o.symbol === symbol);
    if (!stops.length) continue;
    stops.sort((a, b) => b.updateTime - a.updateTime);
    lastStop[symbol] = { id: stops[0].id, isAlgo: stops[0].isAlgo };
    if (stopMode === 'unknown') stopMode = stops[0].isAlgo ? 'algo' : 'standard';
    adopted[symbol] = { orderId: stops[0].id, stopPrice: stops[0].stopPrice, duplicates: stops.length - 1 };
    for (let i = 1; i < stops.length; i++) {
      await cancelStop(symbol, stops[i]);
      console.log(`[LIVE] ${symbol} ลบ SL ซ้ำ ${stops[i].id} @ ${stops[i].stopPrice}`);
    }
  }
  return adopted;
}

// ── Trail: วางใหม่ก่อน แล้วลบเก่า (ไม่มีช่วงไร้ SL) ──
async function trailStopLive(side, qty, newStopPrice, symbol) {
  if (!enabled) return { simulated: true };
  const old = lastStop[symbol];
  try {
    const fresh = await placeStopOrder(symbol, side, qty, newStopPrice);
    if (old && String(old.id) !== String(fresh.orderId)) {
      const ok = await cancelStop(symbol, old);
      if (!ok) staleStops[symbol] = true;   // จำไว้ว่ามีของค้าง
    }
    // ถ้าเคยลบไม่สำเร็จ → กวาดให้เหลือแค่ตัวใหม่ (เก็บกวาดของค้างจากรอบก่อนด้วย)
    if (staleStops[symbol]) {
      const r = await sweepStops(symbol, fresh.orderId);
      if (r.remaining <= 1) staleStops[symbol] = false;
    }
    return fresh;
  } catch (e) {
    console.error(`[LIVE] ${symbol} trailStop:`, e.message);
    return { error: e.message };
  }
}

// ── เปิด position ──
async function openLive(dir, qty, stopPrice, symbol) {
  if (!enabled) return { simulated: true, dir, qty, stopPrice, symbol };
  const out = { stopPlaced: false };
  try {
    const entrySide = dir === 'long' ? 'BUY' : 'SELL';
    const entry = await placeMarketOrder(symbol, entrySide, qty);
    out.entry = entry;
    out.orderId = entry.orderId;
    out.fillPrice = parseFloat(entry.avgPrice) || null;
    out.fillQty = parseFloat(entry.executedQty) || null;
    out.status = entry.status;
  } catch (e) {
    console.error(`[LIVE] ${symbol} entry order:`, e.message);
    return { error: e.message, stopPlaced: false };
  }
  try {
    const stopSide = dir === 'long' ? 'SELL' : 'BUY';
    const stop = await placeStopOrder(symbol, stopSide, qty, stopPrice);
    out.stop = stop;
    out.stopOrderId = stop.orderId;
    out.stopPlaced = true;
  } catch (e) {
    console.error(`[LIVE] ${symbol} ⚠️ STOP ORDER FAILED:`, e.message);
    out.stopError = e.message;
  }
  return out;
}

// ── ปิด position ──
async function closeLive(dir, qty, symbol) {
  if (!enabled) return { simulated: true };
  try {
    // ลบ SL ทุกอันของเหรียญนี้ (ไม่ใช่แค่ตัวล่าสุด) — ถ้าเหลือค้างอาจ trigger เปิดไม้ใหม่!
    await sweepStops(symbol, null);
    lastStop[symbol] = null;
    const closeSide = dir === 'long' ? 'SELL' : 'BUY';
    const close = await placeMarketOrder(symbol, closeSide, qty, true);
    return { close, orderId: close.orderId,
             fillPrice: parseFloat(close.avgPrice) || null,
             fillQty: parseFloat(close.executedQty) || null };
  } catch (e) {
    console.error(`[LIVE] ${symbol} closeLive:`, e.message);
    return { error: e.message };
  }
}

// คืน null = ไม่มี position จริง (ยืนยันแล้ว)
// throw       = เรียกไม่สำเร็จ — ห้ามตีความว่า "ไม่มี position"!
async function getPositionLive(symbol) {
  if (!enabled) return null;
  const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
  if (!Array.isArray(positions)) {
    throw new Error(`positionRisk ตอบผิดรูปแบบ: ${JSON.stringify(positions).slice(0, 120)}`);
  }
  const pos = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
  if (!pos) return null;
  return { dir: parseFloat(pos.positionAmt) > 0 ? 'long' : 'short',
           qty: Math.abs(parseFloat(pos.positionAmt)),
           entry: parseFloat(pos.entryPrice),
           unrealizedPnl: parseFloat(pos.unRealizedProfit) };
}

async function testConnection() {
  if (!enabled) return { ok: false, reason: 'disabled (ยังไม่เปิด LIVE_MODE หรือไม่มี key)' };
  try {
    const acct = await binanceRequest('GET', '/fapi/v2/account', {});
    const usdt = acct.assets?.find(a => a.asset === 'USDT');
    return { ok: true, mode: modeLabel(),
             balance: usdt ? parseFloat(usdt.walletBalance) : 0,
             available: usdt ? parseFloat(usdt.availableBalance) : 0 };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = {
  isEnabled, modeLabel, stopApiMode, setLeverage,
  openLive, closeLive, trailStopLive,
  placeMarketOrder, placeStopOrder, cancelOrder, cancelStop,
  getPositionLive, testConnection, getOpenOrders, getOpenStops, adoptStopOrders, sweepStops,
  _sign: sign, _config: { LIVE_MODE, USE_TESTNET, BASE, LEVERAGE }
};
