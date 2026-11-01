/* Сервер рынка и аукциона для Plate Spin. Без зависимостей: нужен только Node.js 22+.
   Запуск:  BOT_TOKEN=токен_бота node server.js   (порт берётся из PORT, по умолчанию 3000) */
const http = require('http'), crypto = require('crypto'), { DatabaseSync } = require('node:sqlite');
const PORT = +process.env.PORT || 3000, BOT_TOKEN = process.env.BOT_TOKEN || '', DEV = process.env.DEV === '1';
const FEE = 0.07, SNIPE_MS = 120000, MAX_LISTED = 10, MAX_PRICE = 1e9, START_BAL = process.env.START_BAL !== undefined ? +process.env.START_BAL : (DEV ? 250000 : 0);
const db = new DatabaseSync(process.env.DB_FILE || 'game.db');
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT ${START_BAL} CHECK(balance>=0));
CREATE TABLE IF NOT EXISTS plates(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'inv');
CREATE TABLE IF NOT EXISTS listings(id INTEGER PRIMARY KEY AUTOINCREMENT, plate_id INTEGER NOT NULL, seller TEXT NOT NULL, kind TEXT NOT NULL,
  price INTEGER NOT NULL, bid INTEGER NOT NULL DEFAULT 0, bidder TEXT, ends_at INTEGER, status TEXT NOT NULL DEFAULT 'open');
CREATE INDEX IF NOT EXISTS lst_open ON listings(status, kind);`);
const q = s => db.prepare(s);
function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
class Err extends Error {}
const bad = m => { throw new Err(m); };

/* --- проверка подписи Telegram --- */
function auth(initData) {
  if (DEV && /^dev:\w+$/.test(initData)) return initData;
  if (!BOT_TOKEN || !initData) bad('auth');
  const p = new URLSearchParams(initData), hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', key).update(str).digest('hex');
  if (!hash || h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) bad('auth');
  if (Date.now() / 1000 - +p.get('auth_date') > 86400) bad('auth_expired');
  const u = JSON.parse(p.get('user') || '{}'); if (!u.id) bad('auth'); return 'tg' + u.id;
}
function player(id) { q('INSERT OR IGNORE INTO players(id) VALUES(?)').run(id); return q('SELECT * FROM players WHERE id=?').get(id); }

/* --- завершение аукционов (по серверному времени) --- */
function pay(seller, amount) { q('UPDATE players SET balance=balance+? WHERE id=?').run(amount - Math.floor(amount * FEE), seller); }
function settle() {
  tx(() => q("SELECT * FROM listings WHERE status='open' AND kind='auction' AND ends_at<=?").all(Date.now()).forEach(l => {
    if (l.bidder) {
      q('UPDATE plates SET owner=?, state=\'inv\' WHERE id=?').run(l.bidder, l.plate_id); pay(l.seller, l.bid);
      q("UPDATE listings SET status='sold' WHERE id=?").run(l.id);
    } else { q("UPDATE plates SET state='inv' WHERE id=?").run(l.plate_id); q("UPDATE listings SET status='expired' WHERE id=?").run(l.id); }
  }));
}
setInterval(() => { try { settle(); } catch (e) { console.error(e); } }, 5000);

const int = (v, lo, hi) => { v = Math.floor(+v); if (!(v >= lo && v <= hi)) bad('bad_value'); return v; };
const A = {
  me: id => ({ balance: player(id).balance, plates: q("SELECT id, data, state FROM plates WHERE owner=? AND state IN ('inv','listed')").all(id).map(r => ({ id: r.id, state: r.state, plate: JSON.parse(r.data) })) }),
  /* кошелёк рынка: пополнение/вывод (ЭТАП 1: сумму пополнения сообщает клиент — доверие клиенту) */
  wallet_in: (id, b) => tx(() => { const a = int(b.amount, 1, MAX_PRICE); player(id); q('UPDATE players SET balance=balance+? WHERE id=?').run(a, id); return { balance: player(id).balance }; }),
  wallet_out: (id, b) => tx(() => { const a = int(b.amount, 1, MAX_PRICE); if (player(id).balance < a) bad('no_money'); q('UPDATE players SET balance=balance-? WHERE id=?').run(a, id); return { balance: player(id).balance }; }),
  withdraw: (id, b) => tx(() => {   /* вернуть номер с сервера в инвентарь игры */
    const pl = q("SELECT * FROM plates WHERE id=? AND owner=? AND state='inv'").get(int(b.plateId, 1, 1e15), id); if (!pl) bad('not_found');
    q("UPDATE plates SET state='out' WHERE id=?").run(pl.id); return { plate: JSON.parse(pl.data) };
  }),
  /* ЭТАП 1: номер вносится клиентом (доверие клиенту). Этап 2 переносит выпадение номеров на сервер. */
  deposit: (id, b) => { player(id); if (!b.plate || typeof b.plate !== 'object' || JSON.stringify(b.plate).length > 2000) bad('bad_plate'); const r = q('INSERT INTO plates(owner,data) VALUES(?,?)').run(id, JSON.stringify(b.plate)); return { plateId: Number(r.lastInsertRowid) }; },
  market: (id, b) => ({ listings: q(`SELECT l.id, l.kind, l.price, l.bid, l.ends_at, l.seller=? AS mine, l.bidder=? AS leading, p.data FROM listings l JOIN plates p ON p.id=l.plate_id
    WHERE l.status='open' AND (?='' OR l.kind=?) ORDER BY l.kind='auction' DESC, l.ends_at ASC, l.price ASC LIMIT 100`).all(id, id, b.kind || '', b.kind || '').map(r => ({ id: r.id, kind: r.kind, price: r.price, bid: r.bid, endsAt: r.ends_at, mine: !!r.mine, leading: !!r.leading, plate: JSON.parse(r.data) })), now: Date.now() }),
  list: (id, b) => tx(() => {
    const price = int(b.price, 1, MAX_PRICE), kind = b.kind === 'auction' ? 'auction' : 'fixed', hours = kind === 'auction' ? int(b.hours, 1, 24) : 0;
    const pl = q('SELECT * FROM plates WHERE id=? AND owner=?').get(int(b.plateId, 1, 1e15), id); if (!pl) bad('not_found'); if (pl.state !== 'inv') bad('not_available');
    if (q("SELECT COUNT(*) c FROM listings WHERE seller=? AND status='open'").get(id).c >= MAX_LISTED) bad('too_many_listings');
    q("UPDATE plates SET state='listed' WHERE id=?").run(pl.id);
    return { listingId: Number(q('INSERT INTO listings(plate_id,seller,kind,price,ends_at) VALUES(?,?,?,?,?)').run(pl.id, id, kind, price, kind === 'auction' ? Date.now() + hours * 3600000 : null).lastInsertRowid) };
  }),
  buy: (id, b) => tx(() => {
    const l = q("SELECT * FROM listings WHERE id=? AND status='open' AND kind='fixed'").get(int(b.listingId, 1, 1e15)); if (!l) bad('not_available');
    if (l.seller === id) bad('own_listing'); const me = player(id); if (me.balance < l.price) bad('no_money');
    q('UPDATE players SET balance=balance-? WHERE id=?').run(l.price, id); pay(l.seller, l.price);
    q("UPDATE plates SET owner=?, state='inv' WHERE id=?").run(id, l.plate_id); q("UPDATE listings SET status='sold', bidder=?, bid=? WHERE id=?").run(id, l.price, l.id);
    return { balance: me.balance - l.price };
  }),
  bid: (id, b) => tx(() => {
    const l = q("SELECT * FROM listings WHERE id=? AND status='open' AND kind='auction'").get(int(b.listingId, 1, 1e15)); if (!l || l.ends_at <= Date.now()) bad('not_available');
    if (l.seller === id) bad('own_listing'); const amt = int(b.amount, 1, MAX_PRICE), min = l.bidder ? Math.ceil(l.bid * 1.05) : l.price;
    if (amt < min) bad('bid_too_low:' + min); const me = player(id), refund = l.bidder === id ? l.bid : 0;
    if (me.balance + refund < amt) bad('no_money');
    q('UPDATE players SET balance=balance-? WHERE id=?').run(amt - refund, id);               /* деньги ставки замораживаются */
    if (l.bidder && l.bidder !== id) q('UPDATE players SET balance=balance+? WHERE id=?').run(l.bid, l.bidder);  /* прошлому лидеру — возврат */
    const ends = l.ends_at - Date.now() < SNIPE_MS ? Date.now() + SNIPE_MS : l.ends_at;     /* защита от ставок в последний момент */
    q('UPDATE listings SET bid=?, bidder=?, ends_at=? WHERE id=?').run(amt, id, ends, l.id);
    return { balance: me.balance + refund - amt, endsAt: ends };
  }),
  cancel: (id, b) => tx(() => {
    const l = q("SELECT * FROM listings WHERE id=? AND seller=? AND status='open'").get(int(b.listingId, 1, 1e15), id); if (!l) bad('not_found');
    if (l.bidder) bad('has_bids'); q("UPDATE listings SET status='cancelled' WHERE id=?").run(l.id); q("UPDATE plates SET state='inv' WHERE id=?").run(l.plate_id); return {};
  })
};

http.createServer((req, res) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(204, H); return res.end(); }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) { res.writeHead(200, H); return res.end('{"ok":true,"service":"market"}'); }  /* проверка, что сервер жив */
  if (req.method !== 'POST' || req.url !== '/api') { res.writeHead(404, H); return res.end('{"ok":false}'); }
  let body = ''; req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', () => {
    try {
      const b = JSON.parse(body || '{}'), id = auth(b.initData); settle();
      if (!Object.prototype.hasOwnProperty.call(A, b.action)) bad('unknown_action');
      const out = Object.assign({ ok: true }, A[b.action](id, b));
      res.writeHead(200, H); res.end(JSON.stringify(out));
    } catch (e) { if (!(e instanceof Err)) console.error(e); res.writeHead(e instanceof Err ? 200 : 500, H); res.end(JSON.stringify({ ok: false, error: e instanceof Err ? e.message : 'server_error' })); }
  });
}).listen(PORT, () => console.log('Server on :' + PORT + (DEV ? ' (DEV mode)' : '')));
