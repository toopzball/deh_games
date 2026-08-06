// ================================================================
// وُرکرِ مستقلِ «بازی‌ها» — جدا از بک‌اندِ اصلیِ سایت (که روی Pages‌ـه)،
// چون Cloudflare Pages نمی‌تونه خودش Durable Object میزبانی کنه.
// این وُرکر فقط مسیرهای /api/dooz/* رو جواب می‌ده؛ بقیه‌ی سایت (پروفایل/مدیا/چت و...)
// دست‌نخورده روی همون بک‌اندِ Pagesـه.
//
// برای بازی‌های بعدی: همین الگو رو تکرار کن — یه Durable Object جدید برای بازی،
// چندتا مسیرِ /api/<اسمِ‌بازی>/* توی routeRequest، همین‌جا کنارِ بقیه.
// ================================================================

// #region تنظیماتِ مشترک (کپی‌شده از worker.js اصلی؛ باید با هم یکی بمونن)
const ALLOWED_ORIGINS = ["https://dehaat.faggott.fun", "https://dehaato.pages.dev", "https://dehaat.aghey.faggott.fun", "https://dehaat.bbboi.ir"];

function corsHeadersFor(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// دقیقاً همون منطقِ getUserFromToken از worker.js اصلی؛ چون توکن‌ها/سشن‌ها توی همون D1ِ مشترک ذخیره می‌شن،
// این وُرکر با همون توکن‌هایی که سایتِ اصلی صادر می‌کنه کاربر رو می‌شناسه (نیازی به سیستمِ لاگینِ جدا نیست)
async function getUserFromToken(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  const row = await env.D1.prepare(
    "SELECT sessions.expires_at AS expires_at, users.username AS username, users.banned AS banned " +
    "FROM sessions JOIN users ON users.username = sessions.username " +
    "WHERE sessions.token = ?"
  ).bind(token).first();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.D1.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  if (row.banned) return null;

  return row.username;
}

// برای هندشیکِ WebSocket که نمی‌تونه هدرِ سفارشی بفرسته؛ توکن از کوئری‌استرینگ می‌آد
async function getUserFromTokenOrQuery(request, env) {
  const viaHeader = await getUserFromToken(request, env);
  if (viaHeader) return viaHeader;

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return null;

  const session = await env.D1.prepare("SELECT username, expires_at FROM sessions WHERE token = ?").bind(token).first();
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    await env.D1.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }

  const user = await env.D1.prepare("SELECT banned FROM users WHERE username = ?").bind(session.username).first();
  if (!user || user.banned) return null;

  return session.username;
}
// #endregion

// ================================================================
// افزونه‌ی «دوز» برای worker.js — مرحله‌ی اول از قسمتِ بازی‌ها
// ================================================================
// این فایل مستقل اجرا نمی‌شه؛ محتویاتش رو طبقِ راهنمای dooz-integration-README.md
// داخلِ worker.js کپی کن. همه‌ی توابع و کلاس‌ها اینجا با پیشوندِ Dooz/DOOZ اومدن که با
// چیزی از کدِ فعلیت تداخل نداشته باشه.
//
// معماری خلاصه:
//   - هر روم یه Durable Object جداگونه‌ست (DoozRoom)، با idFromName(کدِ روم).
//   - یه Durable Object سینگلتون هم لابیِ روم‌های عمومی رو نگه می‌داره (DoozLobby).
//   - بازی از طریق WebSocket زنده‌ست؛ REST فقط برای ساختن روم/دعوت/لیستِ لابی/چک‌کردنِ کد استفاده می‌شه.
//   - مهره‌ای که هر کاربر نقاشی می‌کنه فقط توی حافظه‌ی همون روم (Durable Object) می‌مونه؛ توی
//     D1 ذخیره نمی‌شه (چون هر بار که وارد بازی می‌شی دوباره نقاشیش می‌کنی) — یعنی هیچ تغییری
//     تو اسکیمای D1 لازم نیست.
// ================================================================

// #region ثابت‌های بازیِ دوز
const DOOZ_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const DOOZ_TURN_MS = 15000;       // مهلتِ هر نوبت؛ اگه بگذره یه خونه‌ی خالی رندوم انتخاب می‌شه
const DOOZ_ROUND_GAP_MS = 2200;   // فاصله‌ی نمایشِ نتیجه‌ی هر دور قبل از شروعِ دورِ بعد
const DOOZ_FORFEIT_GRACE_MS = 25000; // مهلتِ اتصالِ دوباره بعد از قطع‌شدنِ ناگهانی
const DOOZ_MAX_PIECE_LEN = 200000;   // سقفِ حجمِ dataURLِ مهره (~۱۵۰ کیلوبایت بعد از دیکد)

function doozCheckResult(board) {
  for (const [a, b, c] of DOOZ_LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  if (board.every((cell) => cell)) return { winner: "draw", line: null };
  return null;
}

// کدِ روم: بدونِ حروف/عددهای شبیه‌به‌هم (I/1/O/0) که موقعِ دیکته‌کردن اشتباه نشه
function generateDoozCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
// #endregion

// #region Durable Object: اتاقِ بازیِ دوز
export class DoozRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.code = null;
    this.visibility = "private";
    this.hostUsername = null;
    this.players = new Map(); // username -> { ws, avatarFileId, piece, score, connected }
    this.order = [];          // usernامه‌ها به ترتیبِ ورود؛ حداکثر ۲ نفر
    this.board = Array(9).fill(null);
    this.turn = null;
    this.status = "empty";    // empty | waiting | playing | roundover | finished
    this.roundNumber = 0;
    this.winnerLine = null;
    this.matchWinner = null;
    this.deadline = null;
    this.rematchVotes = new Set();
    this._turnTimer = null;
    this._roundTimer = null;
    this._forfeitTimers = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWsUpgrade(request);
    }
    if (url.pathname === "/create" && request.method === "POST") {
      const body = await request.json();
      this.code = body.code;
      this.visibility = body.visibility === "public" ? "public" : "private";
      this.hostUsername = body.hostUsername;
      this.status = "waiting";
      if (this.visibility === "public") this.registerInLobby(body.hostAvatarFileId || null);
      return json({ ok: true });
    }
    if (url.pathname === "/info" && request.method === "GET") {
      return json({
        exists: this.status !== "empty",
        visibility: this.visibility,
        status: this.status,
        playersCount: this.order.length,
        hostUsername: this.hostUsername,
      });
    }
    return json({ error: "مسیر نامعتبر" }, 404);
  }

  handleWsUpgrade(request) {
    const username = request.headers.get("X-Dooz-Username");
    const avatarFileId = request.headers.get("X-Dooz-Avatar") || null;
    if (!username) return json({ error: "احرازِ هویت نامعتبر" }, 401);
    if (this.status === "empty") return json({ error: "همچین رومی وجود نداره" }, 404);

    const isReturning = this.players.has(username);
    if (!isReturning && this.order.length >= 2) {
      return json({ error: "این روم پره" }, 403);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (isReturning) {
      const p = this.players.get(username);
      p.ws = server;
      p.connected = true;
      this.clearForfeitTimer(username);
    } else {
      this.players.set(username, { ws: server, avatarFileId, piece: null, score: 0, connected: true });
      this.order.push(username);
      if (!this.hostUsername) this.hostUsername = username;
    }

    server.addEventListener("message", (evt) => this.onMessage(username, evt));
    server.addEventListener("close", () => this.onClose(username));
    server.addEventListener("error", () => this.onClose(username));

    this.send(server, { t: "hello", you: username, room: this.publicState() });
    this.broadcast();
    this.updateLobbyCount();

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(username, evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    const player = this.players.get(username);
    if (!player || !msg || typeof msg.t !== "string") return;

    if (msg.t === "piece") {
      if (typeof msg.data !== "string" || !msg.data.startsWith("data:image/") || msg.data.length > DOOZ_MAX_PIECE_LEN) return;
      player.piece = msg.data;
      this.maybeStartMatch();
      this.broadcast();
      return;
    }

    if (msg.t === "setVisibility") {
      if (username !== this.hostUsername) return;
      const wasPublic = this.visibility === "public";
      this.visibility = msg.v === "public" ? "public" : "private";
      if (!wasPublic && this.visibility === "public") this.registerInLobby(this.players.get(this.hostUsername)?.avatarFileId || null);
      if (wasPublic && this.visibility !== "public") this.removeFromLobby();
      this.broadcast();
      return;
    }

    if (msg.t === "move") {
      if (this.status !== "playing" || this.turn !== username) return;
      const i = msg.i;
      if (typeof i !== "number" || i < 0 || i > 8 || this.board[i]) return;
      this.applyMove(username, i);
      return;
    }

    if (msg.t === "rematch") {
      if (this.status !== "finished" || this.order.length !== 2) return;
      this.rematchVotes.add(username);
      if (this.order.every((u) => this.rematchVotes.has(u))) {
        this.rematchVotes.clear();
        for (const u of this.order) this.players.get(u).score = 0;
        this.matchWinner = null;
        this.roundNumber = 0;
        this.board = Array(9).fill(null);
        this.winnerLine = null;
        this.startNewRound();
        this.updateLobbyCount();
      }
      this.broadcast();
      return;
    }

    if (msg.t === "leave") {
      this.removePlayer(username);
      return;
    }
    // msg.t === "ping" و بقیه‌ی مقادیرِ ناشناخته عمداً نادیده گرفته می‌شن
  }

  applyMove(username, i) {
    this.board[i] = username;
    this.clearTurnTimer();
    const result = doozCheckResult(this.board);

    if (!result) {
      this.turn = this.otherOf(username);
      this.startTurnTimer();
      this.broadcast();
      return;
    }

    this.winnerLine = result.line;
    if (result.winner !== "draw") {
      const winnerPlayer = this.players.get(result.winner);
      if (winnerPlayer) winnerPlayer.score += 1;
    }

    const winnerPlayer = result.winner !== "draw" ? this.players.get(result.winner) : null;
    if (winnerPlayer && winnerPlayer.score >= 3) {
      this.status = "finished";
      this.matchWinner = result.winner;
      this.turn = null;
      this.updateLobbyCount();
      awardDehpoints(this.env, result.winner, 15).catch(() => {});
      this.broadcast();
      return;
    }

    this.status = "roundover";
    this.turn = null;
    this.broadcast();
    this._roundTimer = setTimeout(() => this.startNewRound(), DOOZ_ROUND_GAP_MS);
  }

  startNewRound() {
    if (this.status !== "roundover" && this.status !== "finished_by_rematch_marker") {
      // اگه هنوز roundover نبود (مثلاً یکی همون حین وسط رفت)، از سرگیری رو رد کن؛
      // مگراینکه این تابع مستقیم از rematch صدا زده شده باشه (که status رو دستی مدیریت می‌کنیم)
    }
    if (this.order.length !== 2) return;
    this.board = Array(9).fill(null);
    this.winnerLine = null;
    this.roundNumber += 1;
    this.turn = this.roundNumber % 2 === 0 ? this.order[1] : this.order[0];
    this.status = "playing";
    this.startTurnTimer();
    this.broadcast();
  }

  maybeStartMatch() {
    if (this.status !== "waiting" || this.order.length !== 2) return;
    const [a, b] = this.order;
    if (!this.players.get(a).piece || !this.players.get(b).piece) return;
    this.roundNumber = 1;
    this.status = "playing";
    this.turn = a;
    this.startTurnTimer();
    this.updateLobbyCount();
  }

  otherOf(username) { return this.order.find((u) => u !== username) || null; }

  startTurnTimer() {
    this.clearTurnTimer();
    this.deadline = Date.now() + DOOZ_TURN_MS;
    this._turnTimer = setTimeout(() => this.autoMove(), DOOZ_TURN_MS);
  }
  clearTurnTimer() {
    if (this._turnTimer) clearTimeout(this._turnTimer);
    this._turnTimer = null;
  }
  autoMove() {
    if (this.status !== "playing" || !this.turn) return;
    const empties = this.board.map((c, i) => (c ? null : i)).filter((v) => v !== null);
    if (!empties.length) return;
    const i = empties[Math.floor(Math.random() * empties.length)];
    this.applyMove(this.turn, i);
  }

  scheduleForfeit(username) {
    this.clearForfeitTimer(username);
    const timer = setTimeout(() => {
      const p = this.players.get(username);
      if (p && !p.connected) this.removePlayer(username);
    }, DOOZ_FORFEIT_GRACE_MS);
    this._forfeitTimers.set(username, timer);
  }
  clearForfeitTimer(username) {
    const t = this._forfeitTimers.get(username);
    if (t) clearTimeout(t);
    this._forfeitTimers.delete(username);
  }

  onClose(username) {
    const player = this.players.get(username);
    if (!player) return;
    player.connected = false;
    player.ws = null;

    if (this.status === "finished" || this.status === "empty") { this.broadcast(); return; }

    if (this.order.length < 2) {
      // فقط یه نفر (میزبانِ تنها) بود که رفت؛ روم رو غیرفعال کن
      this.status = "empty";
      this.removeFromLobby();
      return;
    }
    this.scheduleForfeit(username);
    this.broadcast();
  }

  removePlayer(username) {
    const opponent = this.otherOf(username);
    this.clearForfeitTimer(username);
    this.clearTurnTimer();
    if (this._roundTimer) { clearTimeout(this._roundTimer); this._roundTimer = null; }

    const wasActive = this.status === "playing" || this.status === "waiting" || this.status === "roundover";
    this.players.delete(username);
    this.order = this.order.filter((u) => u !== username);

    if (opponent && this.players.has(opponent)) {
      const opp = this.players.get(opponent);
      if (wasActive) {
        this.status = "finished";
        this.matchWinner = opponent;
        opp.score = Math.max(opp.score, 3);
        this.turn = null;
        this.send(opp.ws, { t: "opponentLeft" });
      }
    } else {
      this.status = "empty";
    }
    this.updateLobbyCount();
    this.broadcast();
  }

  send(ws, obj) {
    if (!ws) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }

  broadcast() {
    const state = this.publicState();
    for (const username of this.order) {
      const p = this.players.get(username);
      if (p && p.ws) this.send(p.ws, { t: "state", room: state });
    }
  }

  publicState() {
    return {
      code: this.code,
      visibility: this.visibility,
      status: this.status,
      board: this.board,
      turn: this.turn,
      deadline: this.deadline,
      roundNumber: this.roundNumber,
      winnerLine: this.winnerLine,
      matchWinner: this.matchWinner,
      hostUsername: this.hostUsername,
      players: this.order.map((u) => {
        const p = this.players.get(u);
        return { username: u, avatarFileId: p.avatarFileId, piece: p.piece, score: p.score, connected: p.connected };
      }),
    };
  }

  // تلاشِ best-effort برای هماهنگ‌نگه‌داشتنِ لیستِ لابی؛ اگه شکست بخوره مهم نیست،
  // چون این فقط رویِ لیستِ روم‌های «عمومیِ بازِ لابی» اثر داره، نه رویِ خودِ بازی
  registerInLobby(hostAvatarFileId) {
    if (!this.env.DOOZ_LOBBY) return;
    const stub = this.env.DOOZ_LOBBY.get(this.env.DOOZ_LOBBY.idFromName("global"));
    stub.fetch("https://internal/register", {
      method: "POST",
      body: JSON.stringify({ code: this.code, hostUsername: this.hostUsername, hostAvatarFileId }),
    }).catch(() => {});
  }
  updateLobbyCount() {
    if (!this.env.DOOZ_LOBBY || this.visibility !== "public") return;
    const stub = this.env.DOOZ_LOBBY.get(this.env.DOOZ_LOBBY.idFromName("global"));
    stub.fetch("https://internal/update", {
      method: "POST",
      body: JSON.stringify({ code: this.code, visibility: this.visibility, status: this.status, playersCount: this.order.length }),
    }).catch(() => {});
  }
  removeFromLobby() {
    if (!this.env.DOOZ_LOBBY) return;
    const stub = this.env.DOOZ_LOBBY.get(this.env.DOOZ_LOBBY.idFromName("global"));
    stub.fetch("https://internal/remove", { method: "POST", body: JSON.stringify({ code: this.code }) }).catch(() => {});
  }
}
// #endregion

// #region Durable Object: لیستِ لابیِ روم‌های عمومی (سینگلتون — idFromName("global"))
export class DoozLobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map(); // code -> {code, hostUsername, hostAvatarFileId, status, playersCount, createdAt}
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.state.storage.get("rooms");
    if (stored) this.rooms = new Map(Object.entries(stored));
    this.loaded = true;
  }
  async persist() {
    await this.state.storage.put("rooms", Object.fromEntries(this.rooms));
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      const b = await request.json();
      this.rooms.set(b.code, {
        code: b.code, hostUsername: b.hostUsername, hostAvatarFileId: b.hostAvatarFileId || null,
        status: "waiting", playersCount: 1, createdAt: Date.now(),
      });
      await this.persist();
      return json({ ok: true });
    }

    if (url.pathname === "/update" && request.method === "POST") {
      const b = await request.json();
      if (b.visibility !== "public") {
        this.rooms.delete(b.code);
      } else if (this.rooms.has(b.code)) {
        const r = this.rooms.get(b.code);
        r.status = b.status;
        r.playersCount = b.playersCount;
      }
      await this.persist();
      return json({ ok: true });
    }

    if (url.pathname === "/remove" && request.method === "POST") {
      const b = await request.json();
      this.rooms.delete(b.code);
      await this.persist();
      return json({ ok: true });
    }

    if (url.pathname === "/list" && request.method === "GET") {
      const now = Date.now();
      const list = [...this.rooms.values()]
        .filter((r) => r.status === "waiting" && r.playersCount < 2 && now - r.createdAt < 30 * 60 * 1000)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 30);
      return json({ rooms: list });
    }

    return json({ error: "مسیر نامعتبر" }, 404);
  }
}
// #endregion

// #region سیستمِ امتیازِ dehpoints (مشترکِ کلِ سایت؛ هر بازیِ دیگه‌ای هم می‌تونه ازش استفاده کنه)
async function awardDehpoints(env, username, amount) {
  if (!username || !amount) return;
  try {
    await env.D1.prepare(
      `INSERT INTO dehpoints (username, points, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET points = points + excluded.points, updated_at = excluded.updated_at`
    ).bind(username, amount, Date.now()).run();
  } catch (e) {
    // اگه جدول هنوز ساخته نشده باشه، سکوت می‌کنیم تا خودِ بازی خراب نشه
  }
}

async function getDehpointsLeaderboard(env, limit = 20) {
  try {
    const { results } = await env.D1.prepare(
      `SELECT d.username AS username, d.points AS points, p.avatar_file_id AS avatarFileId
       FROM dehpoints d
       LEFT JOIN profiles p ON p.username = d.username
       ORDER BY d.points DESC, d.username ASC
       LIMIT ?`
    ).bind(limit).all();
    return results || [];
  } catch (e) {
    return [];
  }
}
// #endregion

// #region هندلرهای REST مسیرهای /api/dooz/*
async function getDoozProfile(env, username) {
  const row = await env.D1.prepare("SELECT avatar_file_id FROM profiles WHERE username = ?").bind(username).first();
  return { username, avatarFileId: (row && row.avatar_file_id) || null };
}

async function handleDoozMe(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const profile = await getDoozProfile(env, username);
  return json({ ok: true, username: profile.username, avatarFileId: profile.avatarFileId });
}

async function handleDoozCreateRoom(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const visibility = body.visibility === "public" ? "public" : "private";
  const profile = await getDoozProfile(env, username);
  const code = generateDoozCode();
  const stub = env.DOOZ_ROOM.get(env.DOOZ_ROOM.idFromName(code));
  await stub.fetch("https://internal/create", {
    method: "POST",
    body: JSON.stringify({ code, visibility, hostUsername: username, hostAvatarFileId: profile.avatarFileId }),
  });
  return json({ ok: true, code, visibility });
}

// #region دعوت به بازیِ دوز — پایدار روی D1 (چون این وُرکر جداست و کاربرِ مقابل باید بتونه
// با پولینگ بفهمه دعوت شده، حتی اگه لحظه‌ی ارسال آنلاین نبود یا صفحه رو رفرش کرد)
// جدولِ لازم توی همون D1ِ مشترک (یک‌بار توی کنسولِ D1 اجرا کن):
//   CREATE TABLE IF NOT EXISTS dooz_invites (
//     id TEXT PRIMARY KEY,
//     code TEXT NOT NULL,
//     from_username TEXT NOT NULL,
//     to_username TEXT NOT NULL,
//     status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | expired | canceled
//     created_at INTEGER NOT NULL,
//     responded_at INTEGER
//   );
//   CREATE INDEX IF NOT EXISTS idx_dooz_invites_to ON dooz_invites (to_username, status);
//   CREATE INDEX IF NOT EXISTS idx_dooz_invites_from ON dooz_invites (from_username, status);
const DOOZ_INVITE_TTL_MS = 60000; // اگه ۶۰ ثانیه جواب داده نشه، منقضی می‌شه

function generateDoozInviteId() {
  return "inv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

async function handleDoozInvite(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const toUsername = (body.toUsername || "").trim();
  if (!toUsername) return json({ error: "یوزرنیمِ حریف رو وارد کن" }, 400);
  if (toUsername === username) return json({ error: "نمی‌تونی خودتو دعوت کنی" }, 400);

  const target = await env.D1.prepare("SELECT username FROM users WHERE username = ?").bind(toUsername).first();
  if (!target) return json({ error: "همچین کاربری پیدا نشد" }, 404);

  // اگه از قبل یه دعوتِ pending بینِ همین دو نفر باشه، دوباره‌فرستی نکن
  try {
    const existing = await env.D1.prepare(
      "SELECT id, code, created_at FROM dooz_invites WHERE from_username = ? AND to_username = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).bind(username, toUsername).first();
    if (existing && Date.now() - existing.created_at < DOOZ_INVITE_TTL_MS) {
      return json({ ok: true, inviteId: existing.id, code: existing.code });
    }
  } catch (e) {}

  const profile = await getDoozProfile(env, username);
  const code = generateDoozCode();
  const stub = env.DOOZ_ROOM.get(env.DOOZ_ROOM.idFromName(code));
  await stub.fetch("https://internal/create", {
    method: "POST",
    body: JSON.stringify({ code, visibility: "private", hostUsername: username, hostAvatarFileId: profile.avatarFileId }),
  });

  const inviteId = generateDoozInviteId();
  try {
    await env.D1.prepare(
      "INSERT INTO dooz_invites (id, code, from_username, to_username, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
    ).bind(inviteId, code, username, toUsername, Date.now()).run();
  } catch (e) {
    // اگه جدول هنوز ساخته نشده، بازم روم ساخته شده و کد برمی‌گرده؛ فقط پولینگِ سمتِ مقابل کار نمی‌کنه
  }

  // پوش‌نوتیفیکیشن: best-effort و بدونِ انتظار — اگه طرف تو خودِ سایت باز نداشته باشه هم با پوش خبردار بشه.
  // نیازمندِ env.MAIN_API_BASE (آدرسِ عمومیِ ورکرِ اصلی) و env.INTERNAL_KEY (همون کلیدِ مشترکِ پروکسیِ Pages)ه.
  if (env.MAIN_API_BASE && env.INTERNAL_KEY) {
    fetch(`${env.MAIN_API_BASE}/api/internal/dooz-invite-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": env.INTERNAL_KEY },
      body: JSON.stringify({ toUsername, fromUsername: username }),
    }).catch(() => {});
  }

  return json({ ok: true, inviteId, code });
}

// فرستنده: انصراف از دعوتی که هنوز جواب داده نشده
async function handleDoozInviteCancel(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const inviteId = (body.inviteId || "").toString();
  if (!inviteId) return json({ error: "درخواست نامعتبره" }, 400);

  const row = await env.D1.prepare(
    "SELECT id, from_username AS fromUsername, status FROM dooz_invites WHERE id = ?"
  ).bind(inviteId).first();
  if (!row) return json({ error: "دعوت پیدا نشد" }, 404);
  if (row.fromUsername !== username) return json({ error: "این دعوت از طرفِ تو نیست" }, 403);
  if (row.status !== "pending") return json({ ok: true, status: row.status }); // از قبل جواب داده شده یا منقضی شده

  await env.D1.prepare("UPDATE dooz_invites SET status = 'canceled', responded_at = ? WHERE id = ?").bind(Date.now(), inviteId).run();
  return json({ ok: true, status: "canceled" });
}

// کاربرِ گیرنده: «آیا کسی دعوتم کرده؟» — با پولینگِ دوره‌ای صدا زده می‌شه
async function handleDoozInvitesPending(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);

  const cutoff = Date.now() - DOOZ_INVITE_TTL_MS;
  let rows = [];
  try {
    const res = await env.D1.prepare(
      "SELECT id, code, from_username AS fromUsername, created_at AS createdAt FROM dooz_invites WHERE to_username = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC"
    ).bind(username, cutoff).all();
    rows = res.results || [];
  } catch (e) {
    rows = [];
  }

  const withAvatars = [];
  for (const r of rows) {
    const profile = await getDoozProfile(env, r.fromUsername);
    withAvatars.push({ ...r, fromAvatarFileId: profile.avatarFileId });
  }
  return json({ ok: true, invites: withAvatars });
}

// فرستنده: وضعیتِ دعوتی که فرستاده رو پولینگ می‌کنه تا از حالتِ «در انتظار» خارج بشه
async function handleDoozInviteStatus(request, env, inviteId) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);

  const row = await env.D1.prepare(
    "SELECT id, code, from_username AS fromUsername, to_username AS toUsername, status, created_at AS createdAt FROM dooz_invites WHERE id = ?"
  ).bind(inviteId).first();
  if (!row) return json({ error: "دعوت پیدا نشد" }, 404);
  if (row.fromUsername !== username && row.toUsername !== username) return json({ error: "دسترسی نداری" }, 403);

  let status = row.status;
  if (status === "pending" && Date.now() - row.createdAt >= DOOZ_INVITE_TTL_MS) {
    status = "expired";
    try { await env.D1.prepare("UPDATE dooz_invites SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(inviteId).run(); } catch (e) {}
  }

  return json({ ok: true, status, code: row.code, fromUsername: row.fromUsername, toUsername: row.toUsername });
}

// گیرنده: قبول/ردِ دعوت
async function handleDoozInviteRespond(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const inviteId = (body.inviteId || "").toString();
  const action = body.action === "accept" ? "accepted" : body.action === "decline" ? "declined" : null;
  if (!inviteId || !action) return json({ error: "درخواست نامعتبره" }, 400);

  const row = await env.D1.prepare(
    "SELECT id, to_username AS toUsername, status, created_at AS createdAt FROM dooz_invites WHERE id = ?"
  ).bind(inviteId).first();
  if (!row) return json({ error: "دعوت پیدا نشد" }, 404);
  if (row.toUsername !== username) return json({ error: "این دعوت برای تو نیست" }, 403);
  if (row.status !== "pending") return json({ error: "این دعوت دیگه فعال نیست" }, 400);
  if (Date.now() - row.createdAt >= DOOZ_INVITE_TTL_MS) {
    try { await env.D1.prepare("UPDATE dooz_invites SET status = 'expired' WHERE id = ?").bind(inviteId).run(); } catch (e) {}
    return json({ error: "این دعوت منقضی شده" }, 400);
  }

  await env.D1.prepare("UPDATE dooz_invites SET status = ?, responded_at = ? WHERE id = ?").bind(action, Date.now(), inviteId).run();
  return json({ ok: true, status: action });
}
// #endregion

async function handleDoozRoomInfo(request, env, code) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  if (!/^[A-Z0-9]{4,10}$/.test(code)) return json({ exists: false });
  const stub = env.DOOZ_ROOM.get(env.DOOZ_ROOM.idFromName(code));
  return await stub.fetch("https://internal/info");
}

async function handleDoozRoomsList(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  if (!env.DOOZ_LOBBY) return json({ rooms: [] });
  const stub = env.DOOZ_LOBBY.get(env.DOOZ_LOBBY.idFromName("global"));
  return await stub.fetch("https://internal/list");
}

// اتصالِ WebSocket؛ توکن از کوئری‌استرینگ می‌آد چون مرورگر موقعِ هندشیکِ WS هدرِ سفارشی نمی‌فرسته
async function handleDoozWs(request, env, url) {
  const username = await getUserFromTokenOrQuery(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const code = (url.searchParams.get("code") || "").toUpperCase().trim();
  if (!/^[A-Z0-9]{4,10}$/.test(code)) return json({ error: "کدِ روم نامعتبره" }, 400);

  const profile = await getDoozProfile(env, username);
  const stub = env.DOOZ_ROOM.get(env.DOOZ_ROOM.idFromName(code));

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set("X-Dooz-Username", username);
  forwardHeaders.set("X-Dooz-Avatar", profile.avatarFileId || "");
  const forwardRequest = new Request(request.url, { headers: forwardHeaders });

  return stub.fetch(forwardRequest);
}
// #endregion

// ================================================================

// #region مسیریابی
async function routeRequest(url, request, env) {
  if (url.pathname === "/api/dooz/me" && request.method === "GET") {
    return await handleDoozMe(request, env);
  }
  if (url.pathname === "/api/dooz/room" && request.method === "POST") {
    return await handleDoozCreateRoom(request, env);
  }
  if (url.pathname === "/api/dooz/invite" && request.method === "POST") {
    return await handleDoozInvite(request, env);
  }
  if (url.pathname === "/api/dooz/invites/pending" && request.method === "GET") {
    return await handleDoozInvitesPending(request, env);
  }
  if (url.pathname === "/api/dooz/invite/respond" && request.method === "POST") {
    return await handleDoozInviteRespond(request, env);
  }
  if (url.pathname === "/api/dooz/invite/cancel" && request.method === "POST") {
    return await handleDoozInviteCancel(request, env);
  }
  if (url.pathname.startsWith("/api/dooz/invite/") && url.pathname.endsWith("/status") && request.method === "GET") {
    const inviteId = decodeURIComponent(url.pathname.split("/")[4] || "");
    return await handleDoozInviteStatus(request, env, inviteId);
  }
  if (url.pathname === "/api/dooz/rooms" && request.method === "GET") {
    return await handleDoozRoomsList(request, env);
  }
  if (url.pathname.startsWith("/api/dooz/room/") && url.pathname.endsWith("/info") && request.method === "GET") {
    const code = decodeURIComponent(url.pathname.split("/")[4] || "").toUpperCase();
    return await handleDoozRoomInfo(request, env, code);
  }
  if (url.pathname === "/api/dooz/ws" && request.method === "GET") {
    return await handleDoozWs(request, env, url);
  }
  if (url.pathname === "/api/dehpoints/leaderboard" && request.method === "GET") {
    const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
    const leaderboard = await getDehpointsLeaderboard(env, limit);
    return json({ ok: true, leaderboard });
  }
  return json({ error: "مسیر پیدا نشد" }, 404);
}
// #endregion

// #region ورودیِ اصلیِ وُرکر
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = corsHeadersFor(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const response = await routeRequest(url, request, env, ctx);

      // پاسخِ آپگریدِ WebSocket رو دست‌نخورده برمی‌گردونیم؛ نمی‌شه رویِ status 101 هدر ست کرد
      if (response.status === 101) {
        return response;
      }

      const finalHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders)) {
        finalHeaders.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers: finalHeaders });
    } catch (err) {
      const errHeaders = new Headers({ "Content-Type": "application/json; charset=utf-8" });
      for (const [key, value] of Object.entries(corsHeaders)) {
        errHeaders.set(key, value);
      }
      return new Response(JSON.stringify({ error: "خطای داخلیِ سرور" }), { status: 500, headers: errHeaders });
    }
  },
};
// #endregion
