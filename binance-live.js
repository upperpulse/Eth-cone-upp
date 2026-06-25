// ═══════════════════════════════════════════════════════════
//  binance-live.js — Binance Futures Order Module
//  ⚠️ ปิดไว้ default (LIVE_MODE=false) — เปิดตอน Phase 4 เท่านั้น
//  รองรับ Testnet (เทสก่อน mainnet)
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');

// ── CONFIG (จาก env) ──
const LIVE_MODE   = process.env.LIVE_MODE === 'true';        // เปิด live (default false = paper)
const USE_TESTNET = process.env.USE_TESTNET !== 'false';     // default true (ปลอดภัย)
const API_KEY     = process.env.BINANCE_KEY || '';
const API_SECRET  = process.env.BINANCE_SECRET || '';
const SYMBOL      = process.env.SYMBOL || 'ETHUSDT';
const LEVERAGE    = parseInt(process.env.LEVERAGE || '3');

// Testnet vs Mainnet URL
const BASE = USE_TESTNET
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

// ── สถานะ module ──
let enabled = !!(LIVE_MODE && API_KEY && API_SECRET);
let lastStopOrderId = null;   // เก็บ order id ของ SL ปัจจุบัน (สำหรับ cancel)

function isEnabled() { return enabled; }
function modeLabel() {
  if (!LIVE_MODE) return 'PAPER';
  if (!API_KEY || !API_SECRET) return 'PAPER (ไม่มี key)';
  return USE_TESTNET ? 'LIVE-TESTNET' : 'LIVE-MAINNET';
}

// ── HMAC SHA256 signature ──
function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

// ── signed request ──
async function binanceRequest(method, path, params = {}) {
  if (!enabled) throw new Error('Live mode disabled');
  const ts = Date.now();
  const query = new URLSearchParams({ ...params, timestamp: ts, recvWindow: 5000 }).toString();
  const signature = sign(query);
  const url = `${BASE}${path}?${query}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  const data = await res.json();
  if (data.code && data.code < 0) {
    throw new Error(`Binance ${data.code}: ${data.msg}`);
  }
  return data;
}

// ── ตั้ง leverage (เรียกครั้งเดียวตอนเริ่ม) ──
async function setLeverage() {
  if (!enabled) return;
  try {
    await binanceRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: LEVERAGE });
    console.log(`[LIVE] leverage set ${LEVERAGE}x`);
  } catch (e) { console.error('[LIVE] setLeverage:', e.message); }
}

// ── เปิด/ปิด position (MARKET) ──
// side: 'BUY' (long/close-short) | 'SELL' (short/close-long)
async function placeMarketOrder(side, qty, reduceOnly = false) {
  if (!enabled) return { simulated: true, side, qty };
  const params = {
    symbol: SYMBOL, side, type: 'MARKET',
    quantity: qty.toFixed(3)
  };
  if (reduceOnly) params.reduceOnly = 'true';
  const order = await binanceRequest('POST', '/fapi/v1/order', params);
  console.log(`[LIVE] MARKET ${side} ${qty.toFixed(3)} → orderId ${order.orderId}`);
  return order;
}

// ── ตั้ง STOP order (SL) ──
// side ตรงข้ามกับ position: long → SELL stop, short → BUY stop
async function placeStopOrder(side, qty, stopPrice) {
  if (!enabled) return { simulated: true, side, stopPrice };
  const params = {
    symbol: SYMBOL, side, type: 'STOP_MARKET',
    quantity: qty.toFixed(3),
    stopPrice: stopPrice.toFixed(2),
    reduceOnly: 'true'
  };
  const order = await binanceRequest('POST', '/fapi/v1/order', params);
  lastStopOrderId = order.orderId;
  console.log(`[LIVE] STOP ${side} @ ${stopPrice.toFixed(2)} → orderId ${order.orderId}`);
  return order;
}

// ── ยกเลิก order ──
async function cancelOrder(orderId) {
  if (!enabled || !orderId) return;
  try {
    await binanceRequest('DELETE', '/fapi/v1/order', { symbol: SYMBOL, orderId });
    console.log(`[LIVE] cancelled order ${orderId}`);
  } catch (e) {
    // order อาจถูก fill/cancel ไปแล้ว — ไม่ใช่ error ร้ายแรง
    console.log(`[LIVE] cancel ${orderId}: ${e.message}`);
  }
}

// ── Trailing SL (cancel เก่า + ตั้งใหม่) ──
// ตั้งใหม่ "ก่อน" cancel เก่า (กันช่วงไม่มี SL)
async function trailStopLive(side, qty, newStopPrice) {
  if (!enabled) return { simulated: true };
  const oldId = lastStopOrderId;
  try {
    // ตั้ง SL ใหม่ก่อน
    const newOrder = await placeStopOrder(side, qty, newStopPrice);
    // แล้วค่อย cancel เก่า
    if (oldId && oldId !== newOrder.orderId) await cancelOrder(oldId);
    return newOrder;
  } catch (e) {
    console.error('[LIVE] trailStop:', e.message);
    return { error: e.message };
  }
}

// ── เปิด position เต็มชุด (market + SL) ──
async function openLive(dir, qty, stopPrice) {
  if (!enabled) return { simulated: true, dir, qty, stopPrice };
  try {
    const entrySide = dir === 'long' ? 'BUY' : 'SELL';
    const stopSide  = dir === 'long' ? 'SELL' : 'BUY';
    const entry = await placeMarketOrder(entrySide, qty);
    const stop  = await placeStopOrder(stopSide, qty, stopPrice);
    return { entry, stop };
  } catch (e) {
    console.error('[LIVE] openLive:', e.message);
    return { error: e.message };
  }
}

// ── ปิด position เต็มชุด (cancel SL + market close) ──
async function closeLive(dir, qty) {
  if (!enabled) return { simulated: true };
  try {
    if (lastStopOrderId) await cancelOrder(lastStopOrderId);
    lastStopOrderId = null;
    const closeSide = dir === 'long' ? 'SELL' : 'BUY';
    const close = await placeMarketOrder(closeSide, qty, true);  // reduceOnly
    return { close };
  } catch (e) {
    console.error('[LIVE] closeLive:', e.message);
    return { error: e.message };
  }
}

// ── เช็ค position จริงบน Binance (sync ตอนเริ่ม) ──
async function getPositionLive() {
  if (!enabled) return null;
  try {
    const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL });
    const pos = positions.find(p => p.symbol === SYMBOL && parseFloat(p.positionAmt) !== 0);
    if (!pos) return null;
    return {
      dir: parseFloat(pos.positionAmt) > 0 ? 'long' : 'short',
      qty: Math.abs(parseFloat(pos.positionAmt)),
      entry: parseFloat(pos.entryPrice),
      unrealizedPnl: parseFloat(pos.unRealizedProfit)
    };
  } catch (e) {
    console.error('[LIVE] getPosition:', e.message);
    return null;
  }
}

module.exports = {
  isEnabled, modeLabel, setLeverage,
  openLive, closeLive, trailStopLive,
  placeMarketOrder, placeStopOrder, cancelOrder, getPositionLive,
  // export สำหรับ test
  _sign: sign, _config: { LIVE_MODE, USE_TESTNET, BASE, SYMBOL, LEVERAGE }
};
