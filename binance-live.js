// ═══════════════════════════════════════════════════════════
//  binance-live.js v2 — Binance Futures Order Module (Multi-Symbol)
//  ⚠️ ปิดไว้ default (LIVE_MODE=false) — เปิดตอนพร้อมเทรด testnet
//  รองรับ: Testnet + หลายเหรียญพร้อมกัน (ETH+SOL)
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');

const LIVE_MODE   = process.env.LIVE_MODE === 'true';
const USE_TESTNET = process.env.USE_TESTNET !== 'false';     // default true (ปลอดภัย!)
const API_KEY     = process.env.BINANCE_KEY || '';
const API_SECRET  = process.env.BINANCE_SECRET || '';
const LEVERAGE    = parseInt(process.env.LEVERAGE || '3');

const BASE = USE_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

let enabled = !!(LIVE_MODE && API_KEY && API_SECRET);
const lastStopOrderId = {};   // แยก SL order id ต่อเหรียญ (สำคัญ!)

const QTY_PRECISION = { ETHUSDT: 3, SOLUSDT: 0, BTCUSDT: 3 };
const PRICE_PRECISION = { ETHUSDT: 2, SOLUSDT: 4, BTCUSDT: 1 };
const qStep = sym => QTY_PRECISION[sym] ?? 3;
const pStep = sym => PRICE_PRECISION[sym] ?? 2;

function isEnabled() { return enabled; }
function modeLabel() {
  if (!LIVE_MODE) return 'PAPER';
  if (!API_KEY || !API_SECRET) return 'PAPER (ไม่มี key)';
  return USE_TESTNET ? 'LIVE-TESTNET' : 'LIVE-MAINNET';
}
function sign(q) { return crypto.createHmac('sha256', API_SECRET).update(q).digest('hex'); }

async function binanceRequest(method, path, params = {}) {
  if (!enabled) throw new Error('Live mode disabled');
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  const url = `${BASE}${path}?${query}&signature=${sign(query)}`;
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`Binance ${data.code}: ${data.msg}`);
  return data;
}

async function setLeverage(symbols = ['ETHUSDT', 'SOLUSDT']) {
  if (!enabled) return;
  for (const symbol of symbols) {
    try {
      await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: LEVERAGE });
      console.log(`[LIVE] ${symbol} leverage ${LEVERAGE}x`);
    } catch (e) { console.error(`[LIVE] setLeverage ${symbol}:`, e.message); }
  }
}

async function placeMarketOrder(symbol, side, qty, reduceOnly = false) {
  if (!enabled) return { simulated: true, symbol, side, qty };
  const params = { symbol, side, type: 'MARKET', quantity: qty.toFixed(qStep(symbol)) };
  if (reduceOnly) params.reduceOnly = 'true';
  const order = await binanceRequest('POST', '/fapi/v1/order', params);
  console.log(`[LIVE] ${symbol} MARKET ${side} ${qty.toFixed(qStep(symbol))} → ${order.orderId}`);
  return order;
}

async function placeStopOrder(symbol, side, qty, stopPrice) {
  if (!enabled) return { simulated: true, symbol, side, stopPrice };
  const params = { symbol, side, type: 'STOP_MARKET', quantity: qty.toFixed(qStep(symbol)),
                   stopPrice: stopPrice.toFixed(pStep(symbol)), reduceOnly: 'true' };
  const order = await binanceRequest('POST', '/fapi/v1/order', params);
  lastStopOrderId[symbol] = order.orderId;
  console.log(`[LIVE] ${symbol} STOP ${side} @ ${stopPrice.toFixed(pStep(symbol))} → ${order.orderId}`);
  return order;
}

async function cancelOrder(symbol, orderId) {
  if (!enabled || !orderId) return;
  try {
    await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId });
    console.log(`[LIVE] ${symbol} cancelled ${orderId}`);
  } catch (e) { console.log(`[LIVE] ${symbol} cancel ${orderId}: ${e.message}`); }
}

async function trailStopLive(side, qty, newStopPrice, symbol) {
  if (!enabled) return { simulated: true };
  const oldId = lastStopOrderId[symbol];
  try {
    const newOrder = await placeStopOrder(symbol, side, qty, newStopPrice);
    if (oldId && oldId !== newOrder.orderId) await cancelOrder(symbol, oldId);
    return newOrder;
  } catch (e) { console.error(`[LIVE] ${symbol} trailStop:`, e.message); return { error: e.message }; }
}

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
  // SL แยก try — ถ้า entry สำเร็จแต่ SL ล้ม ต้องรู้ทันที (position เปลือย!)
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

async function closeLive(dir, qty, symbol) {
  if (!enabled) return { simulated: true };
  try {
    if (lastStopOrderId[symbol]) await cancelOrder(symbol, lastStopOrderId[symbol]);
    lastStopOrderId[symbol] = null;
    const closeSide = dir === 'long' ? 'SELL' : 'BUY';
    const close = await placeMarketOrder(symbol, closeSide, qty, true);
    return { close, orderId: close.orderId,
             fillPrice: parseFloat(close.avgPrice) || null,
             fillQty: parseFloat(close.executedQty) || null };
  } catch (e) { console.error(`[LIVE] ${symbol} closeLive:`, e.message); return { error: e.message }; }
}

async function getPositionLive(symbol) {
  if (!enabled) return null;
  try {
    const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
    const pos = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
    if (!pos) return null;
    return { dir: parseFloat(pos.positionAmt) > 0 ? 'long' : 'short',
             qty: Math.abs(parseFloat(pos.positionAmt)),
             entry: parseFloat(pos.entryPrice),
             unrealizedPnl: parseFloat(pos.unRealizedProfit) };
  } catch (e) { console.error(`[LIVE] ${symbol} getPosition:`, e.message); return null; }
}

// ── ดู order ที่ค้างอยู่ ──
async function getOpenOrders(symbol) {
  if (!enabled) return [];
  try { return await binanceRequest('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {}); }
  catch (e) { console.error(`[LIVE] getOpenOrders:`, e.message); return []; }
}

// ── รับช่วง SL order ที่มีอยู่แล้วบน exchange (ใช้ตอน bot restart) ──
// ถ้าไม่ทำ: bot จะลืม order เดิม → วาง SL ใหม่ทับ = มี SL ซ้อน 2 อัน
async function adoptStopOrders(symbols = []) {
  if (!enabled) return {};
  const adopted = {};
  for (const symbol of symbols) {
    const orders = await getOpenOrders(symbol);
    if (!Array.isArray(orders)) continue;
    const stops = orders.filter(o => (o.type === 'STOP_MARKET' || o.type === 'STOP') && o.reduceOnly);
    if (!stops.length) continue;
    // เรียงใหม่สุดก่อน — ตัวใหม่สุดคือ SL ปัจจุบัน
    stops.sort((a, b) => b.updateTime - a.updateTime);
    lastStopOrderId[symbol] = stops[0].orderId;
    adopted[symbol] = { orderId: stops[0].orderId, stopPrice: parseFloat(stops[0].stopPrice), duplicates: stops.length - 1 };
    // มีซ้ำ (จาก restart ก่อนหน้า) → ลบตัวเก่าทิ้ง
    for (let i = 1; i < stops.length; i++) {
      await cancelOrder(symbol, stops[i].orderId);
      console.log(`[LIVE] ${symbol} ลบ SL ซ้ำ ${stops[i].orderId} @ ${stops[i].stopPrice}`);
    }
  }
  return adopted;
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
  isEnabled, modeLabel, setLeverage,
  openLive, closeLive, trailStopLive,
  placeMarketOrder, placeStopOrder, cancelOrder, getPositionLive, testConnection,
  getOpenOrders, adoptStopOrders,
  _sign: sign, _config: { LIVE_MODE, USE_TESTNET, BASE, LEVERAGE }
};
