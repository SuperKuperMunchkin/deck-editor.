/* ============================================================
   עורך החפיסה — סופר מנצקין־אסטרייכר
   פרויקט עצמאי. אין לו שום תלות בפרויקט המשחק.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const SEED = path.join(__dirname, "cards.json");
const LIVE = path.join(__dirname, "cards-live.json");
const HIST = path.join(__dirname, "history.json");

let CARDS   = JSON.parse(fs.readFileSync(fs.existsSync(LIVE) ? LIVE : SEED, "utf8"));
let HISTORY = fs.existsSync(HIST) ? JSON.parse(fs.readFileSync(HIST, "utf8")) : [];
let rev = 1;
let lastExport = fs.existsSync(path.join(__dirname,"last-export.txt"))
  ? Number(fs.readFileSync(path.join(__dirname,"last-export.txt"),"utf8")) : 0;

/* מי מחובר, ומה כל אחד עורך כרגע */
const users = new Map();     // name -> { seen, editing }
const locks = new Map();     // "id:field" -> { who, at }
const LOCK_MS = 25000;       // מנעול פג אחרי 25 שניות בלי פעילות
const clients = [];          // חיבורים פתוחים לדחיפת שינויים

function persist() {
  try {
    fs.writeFileSync(LIVE, JSON.stringify(CARDS, null, 1));
    fs.writeFileSync(HIST, JSON.stringify(HISTORY.slice(-1500), null, 1));
  } catch (e) { console.error("שמירה נכשלה:", e.message); }
}

/* דחיפה מיידית לכל מי שמחובר */
function push(kind) {
  const msg = `data: ${JSON.stringify({ kind, rev })}\n\n`;
  for (let i = clients.length - 1; i >= 0; i--) {
    try { clients[i].write(msg); } catch { clients.splice(i, 1); }
  }
}

function cleanLocks() {
  const now = Date.now();
  for (const [k, v] of locks) if (now - v.at > LOCK_MS) locks.delete(k);
  for (const [n, v] of users) if (now - v.seen > 40000) users.delete(n);
}
setInterval(() => { const b = locks.size; cleanLocks(); if (locks.size !== b) push("locks"); }, 5000);

const NUM = ["level","treasures","levels","bonus","gold","aura","profile","copies"];
const FIELDS = ["name","text","badStuff","footNote","art","type","deck","slot","size","sex",
                "tags","image","note", ...NUM];

function edit({ id, field, value, who }) {
  const c = CARDS.find(x => x.id === id);
  if (!c) return { err: "הקלף לא נמצא" };
  if (!FIELDS.includes(field)) return { err: "שדה לא מוכר" };

  const key = id + ":" + field;
  const L = locks.get(key);
  if (L && L.who !== who && Date.now() - L.at < LOCK_MS)
    return { err: `${L.who} עורך את השדה הזה כרגע` };

  const before = c[field];
  const same = String(before ?? "") === String(value ?? "");
  if (same) return { ok: true, same: true };

  c[field] = (value === "" || value == null) ? undefined
    : NUM.includes(field) ? (isNaN(Number(value)) ? before : Number(value))
    : field === "tags" ? String(value).split(",").map(s => s.trim()).filter(Boolean)
    : value;

  HISTORY.push({ t: Date.now(), who, id, name: c.name, field,
                 before: before ?? "", after: c[field] ?? "" });
  rev++; persist(); push("edit");
  return { ok: true };
}

const A = {
  hello({ who }) {
    users.set(who, { seen: Date.now(), editing: null });
    return { ok: true, rev };
  },
  ping({ who, editing }) {
    users.set(who, { seen: Date.now(), editing: editing || null });
    if (editing) { locks.set(editing, { who, at: Date.now() }); }
    return { ok: true, rev };
  },
  lock({ who, key }) {
    const L = locks.get(key);
    if (L && L.who !== who && Date.now() - L.at < LOCK_MS)
      return { err: `${L.who} עורך כרגע`, by: L.who };
    locks.set(key, { who, at: Date.now() });
    push("locks");
    return { ok: true };
  },
  unlock({ who, key }) {
    const L = locks.get(key);
    if (L && L.who === who) { locks.delete(key); push("locks"); }
    return { ok: true };
  },
  edit,
  add({ who, type, deck }) {
    const id = "n" + Date.now().toString(36);
    CARDS.push({ id, name: "קלף חדש", type: type || "item", deck: deck || "treasure", text: "" });
    HISTORY.push({ t: Date.now(), who, id, name: "קלף חדש", field: "—", before: "", after: "נוצר" });
    rev++; persist(); push("add");
    return { ok: true, id };
  },
  remove({ id, who }) {
    const i = CARDS.findIndex(c => c.id === id);
    if (i < 0) return { err: "לא נמצא" };
    const [c] = CARDS.splice(i, 1);
    HISTORY.push({ t: Date.now(), who, id, name: c.name, field: "—",
                   before: JSON.stringify(c), after: "נמחק", deleted: true });
    rev++; persist(); push("remove");
    return { ok: true };
  },
  undo({ who }) {
    const last = [...HISTORY].reverse().find(h => !h.undone);
    if (!last) return { err: "אין מה לבטל" };
    if (last.deleted) {                       /* שחזור קלף שנמחק */
      try { CARDS.push(JSON.parse(last.before)); } catch { return { err: "שחזור נכשל" }; }
    } else if (last.field === "—") {          /* ביטול יצירה */
      const i = CARDS.findIndex(c => c.id === last.id);
      if (i >= 0) CARDS.splice(i, 1);
    } else {
      const c = CARDS.find(x => x.id === last.id);
      if (!c) return { err: "הקלף לא קיים" };
      c[last.field] = last.before === "" ? undefined : last.before;
    }
    last.undone = true;
    HISTORY.push({ t: Date.now(), who, id: last.id, name: last.name, field: last.field,
                   before: last.after, after: last.before, undo: true, undone: true });
    rev++; persist(); push("undo");
    return { ok: true };
  },
  import: function ({ who, cards }) {
    if (!Array.isArray(cards) || cards.length < 20) return { err: "הקובץ לא נראה תקין" };
    const bad = cards.find(c => !c || !c.id || !c.name);
    if (bad) return { err: "יש קלף בלי מזהה או שם" };
    const n = CARDS.length;
    CARDS = cards;
    HISTORY.push({ t: Date.now(), who, id: "-", name: "כל החפיסה", field: "—",
                   before: `${n} קלפים`, after: `יובא קובץ · ${cards.length} קלפים` });
    rev++; persist(); push("import");
    return { ok: true, n: cards.length, was: n };
  },

  restore({ who, cards }) {                   /* שחזור מגיבוי הדפדפן */
    if (!Array.isArray(cards) || cards.length < 50) return { err: "גיבוי לא תקין" };
    CARDS = cards;
    HISTORY.push({ t: Date.now(), who, id: "-", name: "כל החפיסה", field: "—",
                   before: "", after: `שוחזר מגיבוי (${cards.length} קלפים)` });
    rev++; persist(); push("restore");
    return { ok: true, n: cards.length };
  },
};

http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const json = o => { res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
                      res.end(JSON.stringify(o)); };

  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }

  /* חיבור מתמשך — השרת דוחף שינויים במקום שישאלו אותו */
  if (u.pathname === "/live") {
    res.writeHead(200, { "Content-Type":"text/event-stream", "Cache-Control":"no-cache",
                         "Connection":"keep-alive", "X-Accel-Buffering":"no" });
    res.write(`data: ${JSON.stringify({ kind:"hello", rev })}\n\n`);
    clients.push(res);
    const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
    req.on("close", () => { clearInterval(beat);
      const i = clients.indexOf(res); if (i >= 0) clients.splice(i, 1); });
    return;
  }

  if (u.pathname === "/cards") return json({ rev, cards: CARDS, lastExport,
    users: [...users.keys()], locks: [...locks.entries()].map(([k,v]) => ({ key:k, who:v.who })) });
  if (u.pathname === "/history") return json({ history: HISTORY.slice(-200).reverse() });
  if (u.pathname === "/export") {
    lastExport = Date.now();
    try { fs.writeFileSync(path.join(__dirname,"last-export.txt"), String(lastExport)); } catch {}
    res.writeHead(200, {"Content-Type":"application/json; charset=utf-8",
      "Content-Disposition":`attachment; filename=cards-${new Date().toISOString().slice(0,10)}.json`});
    return res.end(JSON.stringify(CARDS, null, 1));
  }

  if (u.pathname === "/do" && req.method === "POST") {
    let b = ""; req.on("data", d => { b += d; if (b.length > 5e6) req.destroy(); });
    req.on("end", () => {
      try { const { action, ...a } = JSON.parse(b || "{}");
            json(A[action] ? A[action](a) : { err: "פעולה לא מוכרת" }); }
      catch (e) { json({ err: e.message }); }
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`\n  עורך החפיסה:  http://localhost:${PORT}\n  ${CARDS.length} קלפים\n`));
