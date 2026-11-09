"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

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
app.use(express.json());

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
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const norm = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();

// --- DAFTAR DECK UNTUK HOST (minimal 4 kartu aktif agar bisa jadi pilihan ganda) ---
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

// --- GENERATE SOAL BERDASARKAN DECK YANG DIPILIH HOST ---
app.get(
  "/api/battle/generate",
  asyncRoute(async (req, res) => {
    const limit = Math.max(5, Math.min(50, Number(req.query.limit) || 20));
    const deckIds = [
      ...new Set(
        String(req.query.deckIds || "")
          .split(",")
          .map((x) => Number(x))
          .filter((n) => Number.isSafeInteger(n) && n > 0),
      ),
    ].slice(0, 20);

    if (!deckIds.length) {
      return res.status(400).json({ error: "Pilih minimal 1 deck." });
    }

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

    const selected = shuffle(allCards).slice(0, limit);

    const questions = selected.map((card) => {
      const seen = new Set([norm(card.furigana)]);
      const distractors = [];
      for (const c of shuffle(allCards)) {
        const k = norm(c.furigana);
        if (c.id === card.id || seen.has(k)) continue;
        seen.add(k);
        distractors.push({ text: c.furigana, isCorrect: false });
        if (distractors.length === 3) break;
      }
      const options = shuffle([
        { text: card.furigana, isCorrect: true },
        ...distractors,
      ]);
      return { kanji: card.kanji, arti: card.arti, options };
    });

    res.json({ data: questions });
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