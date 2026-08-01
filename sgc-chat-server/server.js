'use strict';

// Backend for the DOLL-OS/DS sgc-chat dapp (apps/sgc-chat.dapp). Every
// response is HTTP 200 with an "ok" field -- AppRunner's $httpok only
// reflects the transport (2xx + body read), so application-level failures
// (bad password, empty message) have to travel inside the JSON body or the
// dapp can never see them.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 4390;
const DB_PATH = process.env.SGC_CHAT_DB || path.join(__dirname, 'data', 'chat.sqlite');

// A poll response has to fit AppRunner's HTTPGET cap (4096 bytes, see
// docs/DAPP.md). MAX_TEXT_LEN keeps worst case (10 messages, full-width
// text, JSON overhead) comfortably under that.
const MAX_TEXT_LEN = 200;
const MAX_MESSAGES_PER_ROOM = 500;
const MAX_POLL_LIMIT = 10;

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{1,20}$/;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    token TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    room TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room, id);
`);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function authenticate(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  return db.prepare('SELECT * FROM users WHERE token = ?').get(match[1]) || null;
}

const app = express();
app.use(express.json({ limit: '8kb' }));

// Logging in for the first time with a username creates the account --
// there is no separate register step, which keeps the dapp's UI to one
// username/password prompt. Returning visits must match the stored password.
app.post('/auth', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' ||
      !USERNAME_RE.test(username) || password.length < 4 || password.length > 64) {
    return res.json({ ok: false, error: 'bad_request' });
  }

  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const token = makeToken();

  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = `${salt}:${hashPassword(password, salt)}`;
    db.prepare('INSERT INTO users (username, password_hash, token, created_at) VALUES (?, ?, ?, ?)')
      .run(username, hash, token, Date.now());
    return res.json({ ok: true, created: true, token });
  }

  const [salt, storedHash] = existing.password_hash.split(':');
  const candidateHash = hashPassword(password, salt);
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(candidateHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.json({ ok: false, error: 'bad_password' });
  }

  db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, existing.id);
  res.json({ ok: true, created: false, token });
});

app.post('/send', (req, res) => {
  const user = authenticate(req);
  if (!user) return res.json({ ok: false, error: 'unauthorized' });

  let { room, text } = req.body || {};
  room = typeof room === 'string' && ROOM_RE.test(room) ? room : 'lobby';
  text = typeof text === 'string' ? text.trim().slice(0, MAX_TEXT_LEN) : '';
  if (!text) return res.json({ ok: false, error: 'empty' });

  const info = db.prepare(
    'INSERT INTO messages (room, user_id, username, text, ts) VALUES (?, ?, ?, ?, ?)'
  ).run(room, user.id, user.username, text, Date.now());

  // Trim the room to its most recent MAX_MESSAGES_PER_ROOM rows so a
  // long-running room can't grow the database without bound.
  db.prepare(`
    DELETE FROM messages WHERE room = ? AND id <= (
      SELECT id FROM messages WHERE room = ? ORDER BY id DESC LIMIT 1 OFFSET ?
    )
  `).run(room, room, MAX_MESSAGES_PER_ROOM);

  res.json({ ok: true, id: info.lastInsertRowid });
});

// Reading a room requires no account -- only posting does. Cursor-based
// polling (?since=<last id seen>) keeps each response to just the new
// messages instead of replaying the room every call.
//
// since=0 means "I have no cursor yet" -- a client joining a room. It gets the
// most recent MAX_POLL_LIMIT messages, not the oldest ones: walking a 500
// message room forward from the start ten at a time would take fifty polls
// before a joiner saw anything anyone said recently.
app.get('/poll', (req, res) => {
  const room = typeof req.query.room === 'string' && ROOM_RE.test(req.query.room)
    ? req.query.room : 'lobby';
  const since = Number.parseInt(req.query.since, 10) || 0;

  const rows = since > 0
    ? db.prepare(
        'SELECT id, username, text FROM messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?'
      ).all(room, since, MAX_POLL_LIMIT)
    : db.prepare(
        'SELECT id, username, text FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?'
      ).all(room, MAX_POLL_LIMIT).reverse();

  res.json({
    ok: true,
    last_id: rows.length ? rows[rows.length - 1].id : since,
    messages: rows.map((r) => ({ id: r.id, user: r.username, text: r.text })),
  });
});

app.listen(PORT, () => {
  console.log(`sgc-chat-server listening on :${PORT}, db at ${DB_PATH}`);
});
