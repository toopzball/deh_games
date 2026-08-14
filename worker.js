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

// #region مهره‌ی ذخیره‌شده‌ی هر کاربر — به‌جای نقاشیِ دوباره هر بار، یک‌بار می‌سازه و بعدش
// فقط از همون‌جا (دکمه‌ی «ویرایشِ مهره» تو ایندکس) ویرایشش می‌کنه.
// جدولِ لازم توی همون D1ِ مشترک (یک‌بار توی کنسولِ D1 اجرا کن):
//   CREATE TABLE IF NOT EXISTS dooz_pieces (
//     username TEXT PRIMARY KEY,
//     piece TEXT NOT NULL,
//     updated_at INTEGER NOT NULL
//   );
async function handleDoozGetPiece(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  try {
    const row = await env.D1.prepare("SELECT piece FROM dooz_pieces WHERE username = ?").bind(username).first();
    return json({ ok: true, piece: (row && row.piece) || null });
  } catch (e) {
    // اگه جدول هنوز ساخته نشده باشه، یعنی هیچ‌کس مهره‌ای نساخته؛ مثلِ نداشتنِ مهره رفتار کن
    return json({ ok: true, piece: null });
  }
}

async function handleDoozSavePiece(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const data = body.data;
  if (typeof data !== "string" || !data.startsWith("data:image/") || data.length > DOOZ_MAX_PIECE_LEN) {
    return json({ error: "تصویرِ مهره نامعتبره" }, 400);
  }
  try {
    await env.D1.prepare(
      `INSERT INTO dooz_pieces (username, piece, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET piece = excluded.piece, updated_at = excluded.updated_at`
    ).bind(username, data, Date.now()).run();
  } catch (e) {
    return json({ error: "ذخیره‌ی مهره نشد؛ دوباره امتحان کن" }, 500);
  }
  return json({ ok: true });
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
// افزونه‌ی «حکم» برای worker.js — دقیقاً هم‌الگویِ افزونه‌ی دوز، ولی چهارنفره.
// همون معماری: هر روم یه Durable Object جدا (HokmRoom)، یه لابیِ سینگلتون برای
// روم‌های عمومی (HokmLobby)، بازی از طریقِ WebSocket زنده‌ست، REST فقط برای
// ساختن روم/دعوت/لیستِ لابی/چک‌کردنِ کد.
//
// قوانینِ پیاده‌سازی‌شده (نسخه‌ی رایجِ آنلاین، ساده‌شده نسبت به بازیِ کاملاً سنتی):
//   - ۴ نفر، دو تیم روبه‌رو: صندلی‌های ۰و۲ تیمِ A، صندلی‌های ۱و۳ تیمِ B.
//   - حاکمِ دستِ اول: یه دستِ آزمایشیِ کارت (یکی‌یکی چرخشی) می‌ره تا کسی آسِ پیک بگیره؛
//     همون نفر حاکم می‌شه. این دستِ آزمایشی دور ریخته می‌شه و یه دستِ واقعیِ تازه شروع می‌شه.
//   - حاکم اول ۵ تا کارت می‌گیره و حکم (خالِ برتر) رو انتخاب می‌کنه؛ بعد بقیه‌ی ۸تا به حاکم
//     و ۱۳تا به بقیه (به‌ترتیب از نفرِ سمت‌چپِ حاکم) داده می‌شه.
//   - حاکمِ دست‌های بعدی: می‌چرخه، صندلیِ بعدی از حاکمِ دستِ قبل (ساده‌سازیِ آگاهانه؛
//     خیلی از پیاده‌سازی‌های آنلاین همینو استفاده می‌کنن).
//   - هر دست ۱۳ خشت بازی می‌شه؛ باید هم‌خال بود اگه داری، وگرنه حکم یا هرچی. بالاترین
//     کارتِ خالِ رهبر می‌بره مگراینکه حکم بازی شده باشه، اونوقت بالاترین حکم می‌بره.
//   - محضِ سادگی، همین‌که یه تیم به ۷ خشت رسید دست تموم می‌شه؛ اگه تیمِ بازنده صفر خشت
//     داشت، «کُت» حساب می‌شه (۲ امتیاز به‌جایِ ۱).
//   - اولین تیمی که به ۷ امتیازِ دست برسه، برنده‌ی کل بازیه؛ ۲۵ دهپوینت به هرکدوم از اون تیم.
// ================================================================

// #region ثابت‌ها و توابعِ کمکیِ حکم
const HOKM_SUITS = ["hearts", "diamonds", "spades", "clubs"];
const HOKM_RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const HOKM_RANK_VALUE = Object.fromEntries(HOKM_RANKS.map((r, i) => [r, i]));
const HOKM_TEAM_OF_SEAT = [0, 1, 0, 1]; // صندلی ۰و۲ = تیمِ ۰ («A»)، صندلی ۱و۳ = تیمِ ۱ («B»)
const HOKM_TRICKS_TO_WIN_HAND = 7;
const HOKM_POINTS_TO_WIN_MATCH = 7;
const HOKM_TURN_MS = 25000;
const HOKM_TRUMP_PICK_MS = 30000;
const HOKM_TRICK_GAP_MS = 1400;
const HOKM_HAND_GAP_MS = 3200;
const HOKM_FORFEIT_GRACE_MS = 30000;
const HOKM_WIN_POINTS = 25;

function hokmFreshDeck() {
  const deck = [];
  for (const s of HOKM_SUITS) for (const r of HOKM_RANKS) deck.push(`${r}-${s}`);
  return deck;
}
function hokmShuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function hokmCardSuit(card) { return card.split("-")[1]; }
function hokmCardRank(card) { return card.split("-")[0]; }

function generateHokmCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
// #endregion

// #region Durable Object: اتاقِ بازیِ حکم
export class HokmRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.code = null;
    this.visibility = "private";
    this.hostUsername = null;
    this.players = new Map(); // username -> {ws, avatarFileId, seat, hand:[], connected}
    this.order = [];          // usernameها به ترتیبِ نشستن؛ حداکثر ۴ نفر؛ index == seat
    this.status = "empty";    // empty | waiting | dealing_test | choosing_trump | playing | handover | finished
    this.hakemUsername = null;
    this.hakemSeat = null;
    this.trumpSuit = null;
    this.currentTrick = [];   // [{username, seat, card}]
    this.leadSuit = null;
    this.turn = null;
    this.deadline = null;
    this.teamScore = [0, 0];  // [تیمِ A, تیمِ B]
    this.teamTricks = [0, 0]; // خشت‌هایِ گرفته‌شده تویِ دستِ جاری
    this.handNumber = 0;
    this.matchWinnerTeam = null;
    this.lastTrickResult = null; // {winner, seat, cards:[...]} — نمایشِ گذرا
    this.lastHandResult = null;  // {winnerTeam, kot} — نمایشِ گذرا
    this.rematchVotes = new Set();
    this._turnTimer = null;
    this._trumpTimer = null;
    this._gapTimer = null;
    this._forfeitTimers = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") return this.handleWsUpgrade(request);

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
      const who = url.searchParams.get("username");
      return json({
        exists: this.status !== "empty",
        visibility: this.visibility,
        status: this.status,
        playersCount: this.order.length,
        hostUsername: this.hostUsername,
        youAreIn: !!(who && this.players.has(who)),
      });
    }
    return json({ error: "مسیر نامعتبر" }, 404);
  }

  handleWsUpgrade(request) {
    const username = request.headers.get("X-Hokm-Username");
    const avatarFileId = request.headers.get("X-Hokm-Avatar") || null;
    if (!username) return json({ error: "احرازِ هویت نامعتبر" }, 401);
    if (this.status === "empty") return json({ error: "همچین رومی وجود نداره" }, 404);

    const isReturning = this.players.has(username);
    if (!isReturning && this.order.length >= 4) return json({ error: "این روم پره" }, 403);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let seat;
    if (isReturning) {
      const p = this.players.get(username);
      p.ws = server;
      p.connected = true;
      seat = p.seat;
      this.clearForfeitTimer(username);
    } else {
      seat = this.order.length;
      this.players.set(username, { ws: server, avatarFileId, seat, hand: [], connected: true });
      this.order.push(username);
      if (!this.hostUsername) this.hostUsername = username;
    }

    server.addEventListener("message", (evt) => this.onMessage(username, evt));
    server.addEventListener("close", () => this.onClose(username));
    server.addEventListener("error", () => this.onClose(username));

    this.send(server, { t: "hello", you: username, seat, room: this.publicState(), hand: this.players.get(username).hand });
    this.maybeStartTestDeal();
    this.broadcast();
    this.updateLobbyCount();

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(username, evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    const player = this.players.get(username);
    if (!player || !msg || typeof msg.t !== "string") return;

    if (msg.t === "setVisibility") {
      if (username !== this.hostUsername || this.status !== "waiting") return;
      const wasPublic = this.visibility === "public";
      this.visibility = msg.v === "public" ? "public" : "private";
      if (!wasPublic && this.visibility === "public") this.registerInLobby(this.players.get(this.hostUsername)?.avatarFileId || null);
      if (wasPublic && this.visibility !== "public") this.removeFromLobby();
      this.broadcast();
      return;
    }

    if (msg.t === "chooseTrump") {
      if (this.status !== "choosing_trump" || username !== this.hakemUsername) return;
      if (!HOKM_SUITS.includes(msg.suit)) return;
      this.trumpSuit = msg.suit;
      this.clearTrumpTimer();
      this.finishDealAfterTrump();
      return;
    }

    if (msg.t === "playCard") {
      if (this.status !== "playing" || this.turn !== username) return;
      this.tryPlayCard(username, msg.card);
      return;
    }

    if (msg.t === "rematch") {
      if (this.status !== "finished" || this.order.length !== 4) return;
      this.rematchVotes.add(username);
      this.broadcast();
      if (this.order.every((u) => this.rematchVotes.has(u))) {
        this.rematchVotes.clear();
        this.teamScore = [0, 0];
        this.matchWinnerTeam = null;
        this.handNumber = 0;
        this.hakemSeat = null;
        this.hakemUsername = null;
        this.updateLobbyCount();
        this.maybeStartTestDeal(true);
      }
      return;
    }

    if (msg.t === "leave") {
      this.removePlayer(username);
      return;
    }
    // "ping" و بقیه‌ی مقادیرِ ناشناخته عمداً نادیده گرفته می‌شن
  }

  // ---------- شروعِ بازی وقتی هر ۴ صندلی پر شد ----------
  maybeStartTestDeal(force) {
    if (this.order.length !== 4) return;
    if (!force && this.status !== "waiting") return;
    this.status = "dealing_test";
    this.updateLobbyCount();
    this.runTestDealForHakem();
  }

  // دستِ آزمایشی: یکی‌یکی چرخشی می‌ده تا آسِ پیک دربیاد؛ همون نفر حاکم می‌شه.
  // دستِ اول: شروع از صندلیِ میزبان. دست‌هایِ بعدی: حاکمِ جدید = صندلیِ بعدِ حاکمِ قبلی
  // (پس این تابع فقط تویِ همون حالت صدا زده می‌شه، نه هر بار).
  runTestDealForHakem() {
    let startSeat = 0;
    if (this.hakemSeat !== null) startSeat = (this.hakemSeat + 1) % 4;
    const deck = hokmShuffle(hokmFreshDeck());
    let i = 0;
    let hakemSeat = null;
    while (i < deck.length) {
      const seat = (startSeat + i) % 4;
      if (deck[i] === "A-spades") { hakemSeat = seat; break; }
      i++;
    }
    if (hakemSeat === null) hakemSeat = startSeat; // عملاً نمی‌شه، فقط برایِ اطمینان
    this.hakemSeat = hakemSeat;
    this.hakemUsername = this.order[hakemSeat];
    this.startRealDeal();
  }

  // دستِ واقعی: ۵ تا به حاکم، بعد منتظرِ انتخابِ حکم می‌مونه
  startRealDeal() {
    this.handNumber += 1;
    this.teamTricks = [0, 0];
    this.currentTrick = [];
    this.leadSuit = null;
    this.trumpSuit = null;
    this.lastTrickResult = null;
    this.lastHandResult = null;

    const deck = hokmShuffle(hokmFreshDeck());
    for (const u of this.order) this.players.get(u).hand = [];
    const hakemHand = this.players.get(this.hakemUsername).hand;
    for (let i = 0; i < 5; i++) hakemHand.push(deck[i]);
    this._pendingDeck = deck.slice(5); // بقیه‌ی کارت‌ها برایِ بعدِ انتخابِ حکم

    this.status = "choosing_trump";
    this.startTrumpTimer();
    this.broadcastEach();
  }

  finishDealAfterTrump() {
    // ۸ تای بعدی به حاکم، ۱۳تا به بقیه، از نفرِ سمت‌چپِ حاکم شروع می‌شه (چرخشی)
    const deck = this._pendingDeck || [];
    let idx = 0;
    const hakemHand = this.players.get(this.hakemUsername).hand;
    for (let i = 0; i < 8 && idx < deck.length; i++, idx++) hakemHand.push(deck[idx]);

    const others = [];
    for (let k = 1; k <= 3; k++) others.push(this.order[(this.hakemSeat + k) % 4]);
    for (const u of others) {
      const h = this.players.get(u).hand;
      for (let i = 0; i < 13 && idx < deck.length; i++, idx++) h.push(deck[idx]);
    }
    this._pendingDeck = null;

    for (const u of this.order) this.sortHand(this.players.get(u).hand);

    this.status = "playing";
    this.turn = this.hakemUsername; // حاکم اولین نفریه که تو دستِ اول بازی می‌کنه
    this.startTurnTimer();
    this.broadcastEach();
  }

  sortHand(hand) {
    hand.sort((a, b) => {
      const sa = hokmCardSuit(a), sb = hokmCardSuit(b);
      if (sa !== sb) return HOKM_SUITS.indexOf(sa) - HOKM_SUITS.indexOf(sb);
      return HOKM_RANK_VALUE[hokmCardRank(a)] - HOKM_RANK_VALUE[hokmCardRank(b)];
    });
  }

  // ---------- بازی‌کردنِ کارت ----------
  tryPlayCard(username, card) {
    const player = this.players.get(username);
    if (!player || typeof card !== "string") return;
    const idx = player.hand.indexOf(card);
    if (idx === -1) return;

    if (this.currentTrick.length > 0) {
      const mustFollow = this.leadSuit;
      const hasSuit = player.hand.some((c) => hokmCardSuit(c) === mustFollow);
      if (hasSuit && hokmCardSuit(card) !== mustFollow) return; // باید هم‌خال بازی کنه
    } else {
      this.leadSuit = hokmCardSuit(card);
    }

    player.hand.splice(idx, 1);
    this.currentTrick.push({ username, seat: player.seat, card });
    this.clearTurnTimer();

    if (this.currentTrick.length < 4) {
      this.turn = this.order[(player.seat + 1) % 4];
      this.startTurnTimer();
      this.broadcastEach();
      return;
    }

    this.resolveTrick();
  }

  resolveTrick() {
    let winner = this.currentTrick[0];
    for (const entry of this.currentTrick.slice(1)) {
      const entrySuit = hokmCardSuit(entry.card);
      const winnerSuit = hokmCardSuit(winner.card);
      const entryIsTrump = entrySuit === this.trumpSuit;
      const winnerIsTrump = winnerSuit === this.trumpSuit;
      if (entryIsTrump && !winnerIsTrump) { winner = entry; continue; }
      if (!entryIsTrump && winnerIsTrump) continue;
      if (entrySuit === winnerSuit && HOKM_RANK_VALUE[hokmCardRank(entry.card)] > HOKM_RANK_VALUE[hokmCardRank(winner.card)]) {
        winner = entry;
      }
    }

    const winnerTeam = HOKM_TEAM_OF_SEAT[winner.seat];
    this.teamTricks[winnerTeam] += 1;
    this.lastTrickResult = { winner: winner.username, seat: winner.seat, cards: this.currentTrick.slice() };
    this.status = "trickover";
    this.turn = null;
    this.broadcastEach();

    this._gapTimer = setTimeout(() => {
      this.currentTrick = [];
      this.leadSuit = null;
      if (this.teamTricks[winnerTeam] >= HOKM_TRICKS_TO_WIN_HAND) {
        this.finishHand(winnerTeam);
        return;
      }
      this.status = "playing";
      this.turn = winner.username;
      this.startTurnTimer();
      this.broadcastEach();
    }, HOKM_TRICK_GAP_MS);
  }

  finishHand(winnerTeam) {
    const loserTeam = winnerTeam === 0 ? 1 : 0;
    const kot = this.teamTricks[loserTeam] === 0;
    const points = kot ? 2 : 1;
    this.teamScore[winnerTeam] += points;
    this.lastHandResult = { winnerTeam, kot, points, teamTricks: this.teamTricks.slice() };
    this.status = "handover";
    this.turn = null;

    if (this.teamScore[winnerTeam] >= HOKM_POINTS_TO_WIN_MATCH) {
      this.status = "finished";
      this.matchWinnerTeam = winnerTeam;
      this.updateLobbyCount();
      for (const u of this.order) {
        if (HOKM_TEAM_OF_SEAT[this.players.get(u).seat] === winnerTeam) {
          awardDehpoints(this.env, u, HOKM_WIN_POINTS).catch(() => {});
        }
      }
      this.broadcastEach();
      return;
    }

    this.broadcastEach();
    this._gapTimer = setTimeout(() => {
      // حاکمِ دستِ بعد: صندلیِ بعدِ حاکمِ فعلی
      this.hakemSeat = (this.hakemSeat + 1) % 4;
      this.hakemUsername = this.order[this.hakemSeat];
      this.startRealDeal();
    }, HOKM_HAND_GAP_MS);
  }

  // ---------- تایمرها ----------
  startTurnTimer() {
    this.clearTurnTimer();
    this.deadline = Date.now() + HOKM_TURN_MS;
    this._turnTimer = setTimeout(() => this.autoPlay(), HOKM_TURN_MS);
  }
  clearTurnTimer() { if (this._turnTimer) clearTimeout(this._turnTimer); this._turnTimer = null; }
  autoPlay() {
    if (this.status !== "playing" || !this.turn) return;
    const player = this.players.get(this.turn);
    if (!player || !player.hand.length) return;
    let candidates = player.hand;
    if (this.currentTrick.length > 0) {
      const followers = player.hand.filter((c) => hokmCardSuit(c) === this.leadSuit);
      if (followers.length) candidates = followers;
    }
    const card = candidates[Math.floor(Math.random() * candidates.length)];
    this.tryPlayCard(this.turn, card);
  }

  startTrumpTimer() {
    this.clearTrumpTimer();
    this.deadline = Date.now() + HOKM_TRUMP_PICK_MS;
    this._trumpTimer = setTimeout(() => {
      if (this.status !== "choosing_trump") return;
      this.trumpSuit = HOKM_SUITS[Math.floor(Math.random() * HOKM_SUITS.length)];
      this.finishDealAfterTrump();
    }, HOKM_TRUMP_PICK_MS);
  }
  clearTrumpTimer() { if (this._trumpTimer) clearTimeout(this._trumpTimer); this._trumpTimer = null; }

  scheduleForfeit(username) {
    this.clearForfeitTimer(username);
    const timer = setTimeout(() => {
      const p = this.players.get(username);
      if (p && !p.connected) this.removePlayer(username);
    }, HOKM_FORFEIT_GRACE_MS);
    this._forfeitTimers.set(username, timer);
  }
  clearForfeitTimer(username) {
    const t = this._forfeitTimers.get(username);
    if (t) clearTimeout(t);
    this._forfeitTimers.delete(username);
  }

  // ---------- اتصال/قطعی ----------
  onClose(username) {
    const player = this.players.get(username);
    if (!player) return;
    player.connected = false;
    player.ws = null;

    if (this.status === "finished" || this.status === "empty") { this.broadcast(); return; }

    if (this.order.length < 4 && (this.status === "waiting")) {
      // هنوز کامل نشده بود؛ صندلیش رو کامل آزاد کن
      this.removePlayer(username);
      return;
    }
    this.scheduleForfeit(username);
    this.broadcast();
  }

  removePlayer(username) {
    this.clearForfeitTimer(username);
    const wasActive = this.status !== "waiting" && this.status !== "empty" && this.status !== "finished";
    const leavingPlayer = this.players.get(username);
    this.players.delete(username);
    this.order = this.order.filter((u) => u !== username);

    if (wasActive && this.order.length >= 1) {
      // وسطِ بازی یکی رفت؛ چون بازیِ ۴نفره‌یِ تیمی‌ه، نمی‌شه ادامه داد — بازی برایِ همه تموم می‌شه
      // و امتیازی به هیچ‌کس داده نمی‌شه (فقط بازیِ منصفانه به‌هم می‌خوره، نه اینکه کسی متقلب باشه)
      this.clearTurnTimer();
      this.clearTrumpTimer();
      if (this._gapTimer) { clearTimeout(this._gapTimer); this._gapTimer = null; }
      this.status = "finished";
      this.matchWinnerTeam = null;
      this.turn = null;
      for (const u of this.order) {
        const p = this.players.get(u);
        if (p && p.ws) this.send(p.ws, { t: "playerLeft", username });
      }
    }

    if (this.order.length === 0) {
      this.status = "empty";
      this.removeFromLobby();
    } else if (this.status !== "finished") {
      this.status = "waiting";
    }
    this.updateLobbyCount();
    this.broadcastEach();
  }

  // ---------- ارسال/وضعیت ----------
  send(ws, obj) { if (!ws) return; try { ws.send(JSON.stringify(obj)); } catch (e) {} }

  broadcast() { this.broadcastEach(); }

  // هر بازیکن فقط دستِ خودش رو می‌بینه؛ برایِ همین state رو جدا-جدا می‌فرستیم نه یه broadcast مشترک
  broadcastEach() {
    const base = this.publicState();
    for (const username of this.order) {
      const p = this.players.get(username);
      if (p && p.ws) this.send(p.ws, { t: "state", room: base, hand: p.hand });
    }
  }

  publicState() {
    return {
      code: this.code,
      visibility: this.visibility,
      status: this.status,
      hostUsername: this.hostUsername,
      hakemUsername: this.hakemUsername,
      trumpSuit: this.trumpSuit,
      turn: this.turn,
      deadline: this.deadline,
      handNumber: this.handNumber,
      teamScore: this.teamScore,
      teamTricks: this.teamTricks,
      leadSuit: this.leadSuit,
      currentTrick: this.currentTrick,
      lastTrickResult: this.lastTrickResult,
      lastHandResult: this.lastHandResult,
      matchWinnerTeam: this.matchWinnerTeam,
      rematchCount: this.rematchVotes.size,
      players: this.order.map((u) => {
        const p = this.players.get(u);
        return {
          username: u,
          seat: p.seat,
          team: HOKM_TEAM_OF_SEAT[p.seat],
          avatarFileId: p.avatarFileId,
          connected: p.connected,
          cardsLeft: p.hand.length,
        };
      }),
    };
  }

  registerInLobby(hostAvatarFileId) {
    if (!this.env.HOKM_LOBBY) return;
    const stub = this.env.HOKM_LOBBY.get(this.env.HOKM_LOBBY.idFromName("global"));
    stub.fetch("https://internal/register", {
      method: "POST",
      body: JSON.stringify({ code: this.code, hostUsername: this.hostUsername, hostAvatarFileId }),
    }).catch(() => {});
  }
  updateLobbyCount() {
    if (!this.env.HOKM_LOBBY || this.visibility !== "public") return;
    const stub = this.env.HOKM_LOBBY.get(this.env.HOKM_LOBBY.idFromName("global"));
    stub.fetch("https://internal/update", {
      method: "POST",
      body: JSON.stringify({ code: this.code, visibility: this.visibility, status: this.status, playersCount: this.order.length }),
    }).catch(() => {});
  }
  removeFromLobby() {
    if (!this.env.HOKM_LOBBY) return;
    const stub = this.env.HOKM_LOBBY.get(this.env.HOKM_LOBBY.idFromName("global"));
    stub.fetch("https://internal/remove", { method: "POST", body: JSON.stringify({ code: this.code }) }).catch(() => {});
  }
}
// #endregion

// #region Durable Object: لیستِ لابیِ روم‌هایِ عمومیِ حکم (سینگلتون — idFromName("global"))
export class HokmLobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();
    this.loaded = false;
  }
  async load() {
    if (this.loaded) return;
    const stored = await this.state.storage.get("rooms");
    if (stored) this.rooms = new Map(Object.entries(stored));
    this.loaded = true;
  }
  async persist() { await this.state.storage.put("rooms", Object.fromEntries(this.rooms)); }

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
        .filter((r) => r.status === "waiting" && r.playersCount < 4 && now - r.createdAt < 30 * 60 * 1000)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 30);
      return json({ rooms: list });
    }
    return json({ error: "مسیر نامعتبر" }, 404);
  }
}
// #endregion

// #region دعوت به بازیِ حکم — دقیقاً هم‌الگویِ دعوتِ دوز، پایدار روی D1
// جدولِ لازم توی همون D1ِ مشترک (یک‌بار توی کنسولِ D1 اجرا کن):
//   CREATE TABLE IF NOT EXISTS hokm_invites (
//     id TEXT PRIMARY KEY,
//     code TEXT NOT NULL,
//     from_username TEXT NOT NULL,
//     to_username TEXT NOT NULL,
//     status TEXT NOT NULL DEFAULT 'pending',
//     created_at INTEGER NOT NULL,
//     responded_at INTEGER
//   );
//   CREATE INDEX IF NOT EXISTS idx_hokm_invites_to ON hokm_invites (to_username, status);
//   CREATE INDEX IF NOT EXISTS idx_hokm_invites_from ON hokm_invites (from_username, status);
const HOKM_INVITE_TTL_MS = 60000;

function generateHokmInviteId() {
  return "hinv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

async function getHokmProfile(env, username) {
  const row = await env.D1.prepare("SELECT avatar_file_id FROM profiles WHERE username = ?").bind(username).first();
  return { username, avatarFileId: (row && row.avatar_file_id) || null };
}

async function handleHokmMe(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const profile = await getHokmProfile(env, username);
  return json({ ok: true, username: profile.username, avatarFileId: profile.avatarFileId });
}

async function handleHokmCreateRoom(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const visibility = body.visibility === "public" ? "public" : "private";
  const profile = await getHokmProfile(env, username);
  const code = generateHokmCode();
  const stub = env.HOKM_ROOM.get(env.HOKM_ROOM.idFromName(code));
  await stub.fetch("https://internal/create", {
    method: "POST",
    body: JSON.stringify({ code, visibility, hostUsername: username, hostAvatarFileId: profile.avatarFileId }),
  });
  return json({ ok: true, code, visibility });
}

// دعوتِ یه کاربرِ خاص؛ اگه فرستنده از قبل توی یه رومِ بازِ حکم نشسته، همون کد استفاده می‌شه
// (یعنی می‌شه پشتِ‌سرِهم چندنفر رو به یه روم دعوت کرد)، وگرنه یه روم تازه ساخته می‌شه.
async function handleHokmInvite(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const toUsername = (body.toUsername || "").trim();
  let code = (body.code || "").toUpperCase().trim();
  if (!toUsername) return json({ error: "یوزرنیمِ حریف رو وارد کن" }, 400);
  if (toUsername === username) return json({ error: "نمی‌تونی خودتو دعوت کنی" }, 400);

  const target = await env.D1.prepare("SELECT username FROM users WHERE username = ?").bind(toUsername).first();
  if (!target) return json({ error: "همچین کاربری پیدا نشد" }, 404);

  if (!code) {
    const profile = await getHokmProfile(env, username);
    code = generateHokmCode();
    const stub = env.HOKM_ROOM.get(env.HOKM_ROOM.idFromName(code));
    await stub.fetch("https://internal/create", {
      method: "POST",
      body: JSON.stringify({ code, visibility: "private", hostUsername: username, hostAvatarFileId: profile.avatarFileId }),
    });
  }

  const inviteId = generateHokmInviteId();
  try {
    await env.D1.prepare(
      "INSERT INTO hokm_invites (id, code, from_username, to_username, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
    ).bind(inviteId, code, username, toUsername, Date.now()).run();
  } catch (e) {}

  if (env.MAIN_API_BASE && env.INTERNAL_KEY) {
    fetch(`${env.MAIN_API_BASE}/api/internal/hokm-invite-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": env.INTERNAL_KEY },
      body: JSON.stringify({ toUsername, fromUsername: username }),
    }).catch(() => {});
  }

  return json({ ok: true, inviteId, code });
}

async function handleHokmInvitesPending(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const cutoff = Date.now() - HOKM_INVITE_TTL_MS;
  let rows = [];
  try {
    const res = await env.D1.prepare(
      "SELECT id, code, from_username AS fromUsername, created_at AS createdAt FROM hokm_invites WHERE to_username = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC"
    ).bind(username, cutoff).all();
    rows = res.results || [];
  } catch (e) { rows = []; }

  const withAvatars = [];
  for (const r of rows) {
    const profile = await getHokmProfile(env, r.fromUsername);
    withAvatars.push({ ...r, fromAvatarFileId: profile.avatarFileId });
  }
  return json({ ok: true, invites: withAvatars });
}

async function handleHokmInviteRespond(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const inviteId = (body.inviteId || "").toString();
  const action = body.action === "accept" ? "accepted" : body.action === "decline" ? "declined" : null;
  if (!inviteId || !action) return json({ error: "درخواست نامعتبره" }, 400);

  const row = await env.D1.prepare(
    "SELECT id, to_username AS toUsername, status, created_at AS createdAt FROM hokm_invites WHERE id = ?"
  ).bind(inviteId).first();
  if (!row) return json({ error: "دعوت پیدا نشد" }, 404);
  if (row.toUsername !== username) return json({ error: "این دعوت برای تو نیست" }, 403);
  if (row.status !== "pending") return json({ error: "این دعوت دیگه فعال نیست" }, 400);
  if (Date.now() - row.createdAt >= HOKM_INVITE_TTL_MS) {
    try { await env.D1.prepare("UPDATE hokm_invites SET status = 'expired' WHERE id = ?").bind(inviteId).run(); } catch (e) {}
    return json({ error: "این دعوت منقضی شده" }, 400);
  }

  await env.D1.prepare("UPDATE hokm_invites SET status = ?, responded_at = ? WHERE id = ?").bind(action, Date.now(), inviteId).run();
  return json({ ok: true, status: action });
}

async function handleHokmInviteCancel(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const inviteId = (body.inviteId || "").toString();
  if (!inviteId) return json({ error: "درخواست نامعتبره" }, 400);

  const row = await env.D1.prepare(
    "SELECT id, from_username AS fromUsername, status FROM hokm_invites WHERE id = ?"
  ).bind(inviteId).first();
  if (!row) return json({ error: "دعوت پیدا نشد" }, 404);
  if (row.fromUsername !== username) return json({ error: "این دعوت از طرفِ تو نیست" }, 403);
  if (row.status !== "pending") return json({ ok: true, status: row.status });

  await env.D1.prepare("UPDATE hokm_invites SET status = 'canceled', responded_at = ? WHERE id = ?").bind(Date.now(), inviteId).run();
  return json({ ok: true, status: "canceled" });
}

async function handleHokmInviteStatus(request, env, inviteId) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const row = await env.D1.prepare(
    "SELECT id, code, from_username AS fromUsername, to_username AS toUsername, status, created_at AS createdAt FROM hokm_invites WHERE id = ?"
  ).bind(inviteId).first();
  if (!row) return json({ error: "دعوت پیدا نشد" }, 404);
  if (row.fromUsername !== username && row.toUsername !== username) return json({ error: "دسترسی نداری" }, 403);

  let status = row.status;
  if (status === "pending" && Date.now() - row.createdAt >= HOKM_INVITE_TTL_MS) {
    status = "expired";
    try { await env.D1.prepare("UPDATE hokm_invites SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(inviteId).run(); } catch (e) {}
  }
  return json({ ok: true, status, code: row.code, fromUsername: row.fromUsername, toUsername: row.toUsername });
}
// #endregion

async function handleHokmRoomInfo(request, env, code) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  if (!/^[A-Z0-9]{4,10}$/.test(code)) return json({ exists: false });
  const stub = env.HOKM_ROOM.get(env.HOKM_ROOM.idFromName(code));
  return await stub.fetch(`https://internal/info?username=${encodeURIComponent(username)}`);
}

async function handleHokmRoomsList(request, env) {
  const username = await getUserFromToken(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  if (!env.HOKM_LOBBY) return json({ rooms: [] });
  const stub = env.HOKM_LOBBY.get(env.HOKM_LOBBY.idFromName("global"));
  return await stub.fetch("https://internal/list");
}

async function handleHokmWs(request, env, url) {
  const username = await getUserFromTokenOrQuery(request, env);
  if (!username) return json({ error: "لطفاً وارد شو" }, 401);
  const code = (url.searchParams.get("code") || "").toUpperCase().trim();
  if (!/^[A-Z0-9]{4,10}$/.test(code)) return json({ error: "کدِ روم نامعتبره" }, 400);

  const profile = await getHokmProfile(env, username);
  const stub = env.HOKM_ROOM.get(env.HOKM_ROOM.idFromName(code));

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set("X-Hokm-Username", username);
  forwardHeaders.set("X-Hokm-Avatar", profile.avatarFileId || "");
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
  if (url.pathname === "/api/dooz/piece" && request.method === "GET") {
    return await handleDoozGetPiece(request, env);
  }
  if (url.pathname === "/api/dooz/piece" && request.method === "POST") {
    return await handleDoozSavePiece(request, env);
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
  if (url.pathname === "/api/hokm/me" && request.method === "GET") {
    return await handleHokmMe(request, env);
  }
  if (url.pathname === "/api/hokm/room" && request.method === "POST") {
    return await handleHokmCreateRoom(request, env);
  }
  if (url.pathname === "/api/hokm/invite" && request.method === "POST") {
    return await handleHokmInvite(request, env);
  }
  if (url.pathname === "/api/hokm/invites/pending" && request.method === "GET") {
    return await handleHokmInvitesPending(request, env);
  }
  if (url.pathname === "/api/hokm/invite/respond" && request.method === "POST") {
    return await handleHokmInviteRespond(request, env);
  }
  if (url.pathname === "/api/hokm/invite/cancel" && request.method === "POST") {
    return await handleHokmInviteCancel(request, env);
  }
  if (url.pathname.startsWith("/api/hokm/invite/") && url.pathname.endsWith("/status") && request.method === "GET") {
    const inviteId = decodeURIComponent(url.pathname.split("/")[4] || "");
    return await handleHokmInviteStatus(request, env, inviteId);
  }
  if (url.pathname === "/api/hokm/rooms" && request.method === "GET") {
    return await handleHokmRoomsList(request, env);
  }
  if (url.pathname.startsWith("/api/hokm/room/") && url.pathname.endsWith("/info") && request.method === "GET") {
    const code = decodeURIComponent(url.pathname.split("/")[4] || "").toUpperCase();
    return await handleHokmRoomInfo(request, env, code);
  }
  if (url.pathname === "/api/hokm/ws" && request.method === "GET") {
    return await handleHokmWs(request, env, url);
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
