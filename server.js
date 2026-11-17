"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { randomInt, createHash } = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (e) => console.error("Postgres error:", e.message));
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  );
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(ROOT));

// --- ROUTES VIEW ---
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.get("/backsound", (req, res) => res.sendFile(path.join(ROOT, "backsound.mp3")));
app.get("/room", (req, res) => res.sendFile(path.join(ROOT, "room.html")));
app.get("/game-mode", (req, res) =>
  res.sendFile(path.join(ROOT, "game-mode.html")),
);

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); // Fisher-Yates, RNG kriptografis (tanpa bias)
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const norm = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();

const MAX_LIMIT = 1000; // jumlah soal bebas (custom), maks 1000
const parseLimit = (v) => Math.max(5, Math.min(MAX_LIMIT, Math.floor(Number(v)) || 20));
const parseSeen = (v) => new Set(Array.isArray(v) ? v.slice(0, 5000).map(String) : []);
// ID unik per kosakata (kanji+bacaan) -> dipakai melacak kanji yang sudah/belum pernah muncul
const keyOf = (c) =>
  createHash("md5").update(`${norm(c.kanji)}|${norm(c.furigana)}`).digest("hex").slice(0, 10);

// Satu soal pilihan ganda (opsi diacak Fisher-Yates)
function makeQuestion(card, pool) {
  const seen = new Set([norm(card.furigana)]);
  const distractors = [];
  for (const c of shuffle(pool)) {
    const k = norm(c.furigana);
    if (c === card || seen.has(k)) continue;
    seen.add(k);
    distractors.push({ text: c.furigana, isCorrect: false });
    if (distractors.length === 3) break;
  }
  const options = shuffle([{ text: card.furigana, isCorrect: true }, ...distractors]);
  return { key: card.key, kanji: card.kanji, arti: card.arti, options };
}

// Pemilihan CERDAS: kanji yang belum pernah muncul (seen) SELALU didahulukan.
// Kanji lama hanya dipakai untuk mengisi sisa kuota. Jika semua kanji sudah pernah muncul -> siklus baru.
function buildQuiz(allCards, limit, seen = new Set()) {
  const map = new Map();
  for (const c of allCards) {
    const k = keyOf(c);
    if (!map.has(k)) map.set(k, { ...c, key: k });
  }
  const uniq = [...map.values()];

  let unseen = uniq.filter((c) => !seen.has(c.key));
  let cycleReset = false;
  let old = uniq.filter((c) => seen.has(c.key));
  if (!unseen.length) { unseen = uniq; old = []; cycleReset = true; }

  const picked = shuffle([...shuffle(unseen), ...shuffle(old)].slice(0, limit));
  const pickedKeys = new Set(picked.map((c) => c.key));
  const rest = uniq.filter((c) => !pickedKeys.has(c.key));
  const extra = shuffle(rest.length >= 3 ? rest : uniq).slice(0, 3);

  return {
    questions: picked.map((c) => makeQuestion(c, uniq)),
    tiebreak: extra.map((c) => makeQuestion(c, uniq)),
    meta: {
      keys: picked.map((c) => c.key),
      cycleReset,
      total: uniq.length,
      remaining: unseen.length - Math.min(limit, unseen.length), // kanji yang BELUM muncul setelah game ini
    },
  };
}

// --- DAFTAR DECK UNTUK HOST ---
app.get(
  "/api/battle/decks",
  asyncRoute(async (req, res) => {
    const r = await pool.query(
      `SELECT d.id, d.name, d.color, d.icon, COUNT(f.id)::int AS card_count
       FROM decks d
       JOIN flashcards f ON f.deck_id = d.id AND f.archived = false
       WHERE d.archived = false
       GROUP BY d.id
       HAVING COUNT(f.id) >= 4
       ORDER BY d.name`,
    );
    res.json({ data: r.rows });
  }),
);

// --- GENERATE SOAL DARI DECK (GET lama tetap jalan, POST membawa daftar "seen") ---
async function generateFromDecks(req, res, src) {
  const limit = parseLimit(src.limit);
  const rawIds = Array.isArray(src.deckIds) ? src.deckIds : String(src.deckIds || "").split(",");
  const deckIds = [
    ...new Set(rawIds.map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0)),
  ].slice(0, 20);

  if (!deckIds.length) return res.status(400).json({ error: "Pilih minimal 1 deck." });

  const r = await pool.query(
    `SELECT id, kanji, furigana, arti
     FROM flashcards
     WHERE archived = false AND deck_id = ANY($1::bigint[])`,
    [deckIds.map(String)],
  );
  const allCards = r.rows;

  const uniqueReadings = new Set(allCards.map((c) => norm(c.furigana)));
  if (allCards.length < 4 || uniqueReadings.size < 4) {
    return res.status(400).json({
      error: "Deck terpilih minimal butuh 4 kosakata dengan cara baca berbeda.",
    });
  }

  const quiz = buildQuiz(allCards, limit, parseSeen(src.seen));
  res.json({ data: quiz.questions, tiebreak: quiz.tiebreak, meta: quiz.meta });
}
app.get("/api/battle/generate", asyncRoute((req, res) => generateFromDecks(req, res, req.query)));
app.post("/api/battle/generate", asyncRoute((req, res) => generateFromDecks(req, res, req.body || {})));

// --- GENERATE SOAL DARI DAFTAR KANJI CUSTOM (JSON) ---
// Body: { limit: 20, seen: [..], cards: [{ kanji, furigana (atau carabaca), arti }] }
app.post(
  "/api/battle/generate-custom",
  asyncRoute(async (req, res) => {
    const limit = parseLimit(req.body.limit);
    const raw = req.body.cards;

    if (!Array.isArray(raw) || !raw.length) {
      return res.status(400).json({ error: "Daftar kanji kosong atau format salah." });
    }
    if (raw.length > 500) {
      return res.status(400).json({ error: "Maksimal 500 kosakata." });
    }

    const cards = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i] || {};
      const kanji = String(c.kanji ?? "").trim().slice(0, 60);
      const furigana = String(c.furigana ?? c.carabaca ?? "").trim().slice(0, 60);
      const arti = String(c.arti ?? "").trim().slice(0, 200);
      if (!kanji || !furigana || !arti) {
        return res.status(400).json({
          error: `Item #${i + 1} tidak lengkap (butuh kanji, furigana, arti).`,
        });
      }
      cards.push({ kanji, furigana, arti });
    }

    const uniqueReadings = new Set(cards.map((c) => norm(c.furigana)));
    if (cards.length < 4 || uniqueReadings.size < 4) {
      return res.status(400).json({
        error: "Minimal 4 kosakata dengan cara baca berbeda.",
      });
    }

    const quiz = buildQuiz(cards, limit, parseSeen(req.body.seen));
    res.json({ data: quiz.questions, tiebreak: quiz.tiebreak, meta: quiz.meta });
  }),
);

app.use((req, res) => {
  if (req.path.startsWith("/api/"))
    return res.status(404).json({ error: "Endpoint tidak ditemukan." });
  res.status(404).send("Halaman tidak ditemukan.");
});

app.use((err, req, res, next) => {
  console.error("Request failed:", err.message);
  res
    .status(err.status || 500)
    .json({ error: err.status ? err.message : "Terjadi kesalahan server." });
});

app.listen(PORT, () =>
  console.log(`🚀 Kanji Battle Server aktif: http://localhost:${PORT}`),
);