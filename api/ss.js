// Secret Santa API — one Vercel serverless function, no dependencies.
// Storage: Upstash Redis REST (added from Vercel → Storage → Upstash Redis).
// Env vars: FAMILY_CODE, ADMIN_PIN, and the KV_REST_API_URL / KV_REST_API_TOKEN pair Vercel injects.
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const FAMILY = (process.env.FAMILY_CODE || '').trim().toLowerCase();
const ADMIN = (process.env.ADMIN_PIN || '').trim();
const P = process.env.KEY_PREFIX || 'ss:';
const K = {
  people: P + 'people', settings: P + 'settings', assign: P + 'assign',
  pins: P + 'pins', drawn: P + 'drawn', wish: P + 'wish',
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

async function redis(cmds) {
  const r = await fetch(DB_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) fail(502, 'Database error (' + r.status + ')');
  const out = await r.json();
  return out.map(x => { if (x.error) fail(502, 'Database error: ' + x.error); return x.result; });
}

const pairs = arr => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const pinHash = (id, pin) => sha(FAMILY + ':' + id + ':' + pin);
const safeEq = (a, b) => {
  const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
};
const DEFAULT_SETTINGS = { title: 'Family Secret Santa', budget: '', date: '', noSpouse: true };

async function load() {
  const [people, settings, assign, pins, drawn, wish] = await redis([
    ['GET', K.people], ['GET', K.settings], ['EXISTS', K.assign],
    ['HKEYS', K.pins], ['HGETALL', K.drawn], ['HGETALL', K.wish],
  ]);
  return {
    people: parse(people, []),
    settings: { ...DEFAULT_SETTINGS, ...parse(settings, {}) },
    started: assign === 1,
    pinIds: new Set(pins || []),
    drawn: pairs(drawn),
    wish: pairs(wish),
  };
}

function publicState(s) {
  const wishes = {};
  for (const p of s.people) wishes[p.id] = parse(s.wish[p.id], []);
  return {
    settings: s.settings,
    started: s.started,
    people: s.people.map(p => ({ ...p, hasPin: s.pinIds.has(p.id), drawn: !!s.drawn[p.id] })),
    wishes,
  };
}

// ---------- the draw ----------
function randInt(n) { return crypto.randomInt(n); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function makeDraw(people, noSpouse) {
  const ids = people.map(p => p.id);
  const spouse = Object.fromEntries(people.map(p => [p.id, p.spouseId || null]));
  const ok = (g, r) => g !== r && !(noSpouse && spouse[g] === r);
  // Uniformly random among valid draws: shuffle until every rule holds.
  for (let t = 0; t < 50000; t++) {
    const rs = shuffle(ids.slice());
    if (ids.every((g, i) => ok(g, rs[i]))) return Object.fromEntries(ids.map((g, i) => [g, rs[i]]));
  }
  // Fallback for very constrained groups: randomized backtracking (still guarantees validity).
  const out = {}, used = new Set(), order = shuffle(ids.slice());
  const bt = i => {
    if (i === order.length) return true;
    for (const r of shuffle(ids.slice())) {
      if (!used.has(r) && ok(order[i], r)) {
        used.add(r); out[order[i]] = r;
        if (bt(i + 1)) return true;
        used.delete(r); delete out[order[i]];
      }
    }
    return false;
  };
  return bt(0) ? out : null;
}

// ---------- validation ----------
function normPeople(list) {
  if (!Array.isArray(list)) fail(400, 'People must be a list.');
  const out = [], names = new Set(), ids = new Set();
  for (const raw of list.slice(0, 80)) {
    const name = String(raw && raw.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) continue;
    const key = name.toLowerCase();
    if (names.has(key)) fail(400, 'Two people are named "' + name + '". Add a last initial to tell them apart.');
    names.add(key);
    let id = typeof raw.id === 'string' && /^[a-z0-9]{4,16}$/i.test(raw.id) ? raw.id : '';
    if (!id || ids.has(id)) id = crypto.randomBytes(5).toString('hex');
    ids.add(id);
    out.push({ id, name, spouseId: typeof raw.spouseId === 'string' ? raw.spouseId : null });
  }
  // Spouses must exist and be mutual; first claim wins.
  const byId = Object.fromEntries(out.map(p => [p.id, p]));
  const paired = {};
  for (const p of out) {
    const s = p.spouseId;
    if (!s || s === p.id || !byId[s] || paired[p.id] || (paired[s] && paired[s] !== p.id)) continue;
    paired[p.id] = s; paired[s] = p.id;
  }
  for (const p of out) p.spouseId = paired[p.id] || null;
  return out;
}

function normWish(items) {
  if (!Array.isArray(items)) fail(400, 'Wishlist must be a list.');
  return items.slice(0, 40).map(it => {
    const title = String(it && it.title || '').trim().slice(0, 120);
    let url = String(it && it.url || '').trim().slice(0, 600);
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { if (url) new URL(url); } catch { url = ''; }
    const note = String(it && it.note || '').trim().slice(0, 240);
    const id = typeof it.id === 'string' && /^[a-z0-9]{4,16}$/i.test(it.id) ? it.id : crypto.randomBytes(4).toString('hex');
    return { id, title, url, note };
  }).filter(it => it.title || it.url);
}

async function checkPin(state, personId, pin) {
  if (!state.people.some(p => p.id === personId)) fail(404, "That person isn't on the list anymore.");
  if (!/^\d{4}$/.test(String(pin || ''))) fail(400, 'Your PIN is 4 digits.');
  const [stored] = await redis([['HGET', K.pins, personId]]);
  if (!stored) fail(409, 'No PIN set yet.');
  if (!safeEq(stored, pinHash(personId, pin))) fail(403, "That PIN doesn't match.");
}

// ---------- handler ----------
module.exports = async (req, res) => {
  const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
  try {
    if (!DB_URL || !DB_TOKEN) fail(500, 'No database connected. In Vercel, open Storage and add Upstash Redis to this project.');
    if (!FAMILY || !ADMIN) fail(500, 'Set FAMILY_CODE and ADMIN_PIN in the Vercel project settings.');
    const code = String(req.headers['x-family-code'] || '').trim().toLowerCase();
    if (!safeEq(code, FAMILY)) fail(401, "That family code isn't right.");

    let b = {};
    try { b = req.body || {}; } catch { fail(400, 'Could not read the request.'); }
    if (typeof b === 'string') b = parse(b, {});
    const action = (req.query && req.query.action) || b.action || 'state';
    const s = await load();

    if (action === 'state') return send(200, publicState(s));

    if (action === 'login') {
      const { personId, pin } = b;
      if (!s.people.some(p => p.id === personId)) fail(404, "That person isn't on the list anymore.");
      if (!/^\d{4}$/.test(String(pin || ''))) fail(400, 'Pick 4 digits.');
      const [created] = await redis([['HSETNX', K.pins, personId, pinHash(personId, pin)]]);
      if (created !== 1) await checkPin(s, personId, pin);
      return send(200, { ok: true, created: created === 1 });
    }

    if (action === 'reveal') {
      await checkPin(s, b.personId, b.pin);
      if (!s.started) fail(409, "The draw hasn't started yet.");
      const [raw] = await redis([['GET', K.assign]]);
      const receiverId = parse(raw, {})[b.personId];
      if (!receiverId) fail(409, 'You were added after the draw started. Ask the organizer to reset the draw.');
      await redis([['HSETNX', K.drawn, b.personId, String(Date.now())]]);
      return send(200, { receiverId });
    }

    if (action === 'saveWish') {
      await checkPin(s, b.personId, b.pin);
      const items = normWish(b.items);
      await redis([['HSET', K.wish, b.personId, JSON.stringify(items)]]);
      return send(200, { items });
    }

    if (action === 'admin') {
      if (!safeEq(String(b.adminPin || '').trim(), ADMIN)) fail(403, "That organizer PIN doesn't match.");
      const op = b.op;
      if (op === 'check') return send(200, { ok: true });

      if (op === 'saveSettings') {
        const v = b.settings || {};
        const next = {
          title: String(v.title || '').trim().slice(0, 60) || DEFAULT_SETTINGS.title,
          budget: String(v.budget || '').trim().slice(0, 30),
          date: /^\d{4}-\d{2}-\d{2}$/.test(v.date || '') ? v.date : '',
          noSpouse: !!v.noSpouse,
        };
        if (s.started && next.noSpouse !== s.settings.noSpouse) fail(409, 'Reset the draw before changing the spouse rule.');
        await redis([['SET', K.settings, JSON.stringify(next)]]);
      } else if (op === 'savePeople') {
        const people = normPeople(b.people);
        if (s.started) {
          const sig = l => l.map(p => p.id + '>' + (p.spouseId || '')).sort().join(',');
          if (sig(people) !== sig(s.people)) fail(409, 'The draw has started, so you can only fix spelling. Reset the draw to add, remove or pair people.');
        }
        const gone = s.people.map(p => p.id).filter(id => !people.some(p => p.id === id));
        const cmds = [['SET', K.people, JSON.stringify(people)]];
        if (gone.length) cmds.push(['HDEL', K.pins, ...gone], ['HDEL', K.wish, ...gone], ['HDEL', K.drawn, ...gone]);
        await redis(cmds);
      } else if (op === 'start') {
        if (s.started) fail(409, 'The draw has already started.');
        if (s.people.length < 2) fail(400, 'Add at least two people first.');
        const draw = makeDraw(s.people, s.settings.noSpouse);
        if (!draw) fail(400, "There's no way to draw names with these rules. Add people, or turn off the spouse rule.");
        const [set] = await redis([['SET', K.assign, JSON.stringify(draw), 'NX']]);
        if (set !== 'OK') fail(409, 'The draw has already started.');
      } else if (op === 'resetDraw') {
        await redis([['DEL', K.assign, K.drawn]]);
      } else if (op === 'resetPin') {
        await redis([['HDEL', K.pins, String(b.personId || '')]]);
      } else {
        fail(400, 'Unknown organizer action.');
      }
      return send(200, publicState(await load()));
    }

    fail(400, 'Unknown action.');
  } catch (e) {
    if (!e.status) console.error(e);
    try { send(e.status || 500, { error: e.status ? e.message : 'Server error: ' + String(e && e.message || e).slice(0, 200) }); } catch {}
  }
};

module.exports.makeDraw = makeDraw;
module.exports.normPeople = normPeople;
