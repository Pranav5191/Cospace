const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 8081;

const MessageType = {
  JOIN_ROOM: 'join_room', JOIN_ROOM_ACK: 'join_room_ack', LEAVE_ROOM: 'leave_room',
  USER_JOINED: 'user_joined', USER_LEFT: 'user_left', EDIT_OPERATION: 'edit_operation',
  CURSOR_UPDATE: 'cursor_update', SELECTION_UPDATE: 'selection_update',
  TYPING_START: 'typing_start', TYPING_STOP: 'typing_stop', ACTIVITY_LOG: 'activity_log',
  ROLE_CHANGE: 'role_change', HOST_TRANSFER: 'host_transfer', ERROR: 'error',
  PING: 'ping', PONG: 'pong', PASSCODE_REQUIRED: 'passcode_required',
  PASSCODE_VALIDATE: 'passcode_validate', PASSCODE_RESULT: 'passcode_result',
  SYNC_REQUEST: 'sync_request', SYNC_RESPONSE: 'sync_response'
};

class User {
  constructor(id, name, socket, role = 'participant') {
    this.id = id; this.name = name; this.socket = socket; this.role = role;
    this.joinedAt = Date.now(); this.lastActivity = Date.now();
    this.cursorPosition = { line: 0, column: 0 }; this.selection = null;
    this.isTyping = false; this.typingTimeout = null;
    this.color = ['#00d4aa', '#6366f1', '#fbbf24', '#f87171', '#a855f7', '#f97316', '#06b6d4', '#ec4899'][Math.floor(Math.random() * 8)];
  }
  updateActivity() { this.lastActivity = Date.now(); }
  setTyping(isTyping) { this.isTyping = isTyping; if (isTyping && this.typingTimeout) clearTimeout(this.typingTimeout); if (isTyping) this.typingTimeout = setTimeout(() => { this.isTyping = false; }, 3000); }
  toJSON() { return { id: this.id, name: this.name, role: this.role, joinedAt: this.joinedAt, cursorPosition: this.cursorPosition, selection: this.selection, isTyping: this.isTyping, color: this.color }; }
}

class Room {
  constructor(id, hostId, passcode = null) {
    this.id = id.toUpperCase(); this.passcodeHash = passcode ? bcrypt.hashSync(passcode, 10) : null;
    this.hostId = hostId; this.users = new Map(); this.documentContent = '';
    this.documentVersion = 0; this.activityLog = []; this.createdAt = Date.now(); this.operationHistory = [];
  }
  addUser(user) { this.users.set(user.id, user); this.logActivity(`${user.name} joined`, 'join', user.id); }
  removeUser(userId) { const u = this.users.get(userId); if (u) { this.users.delete(userId); this.logActivity(`${u.name} left`, 'leave', userId); return u; } return null; }
  getUser(id) { return this.users.get(id); }
  getUsers() { return Array.from(this.users.values()); }
  getHost() { return this.users.get(this.hostId); }
  setHost(id) { this.hostId = id; const u = this.users.get(id); if (u) u.role = 'host'; }
  transferHost() { const rem = this.getUsers().filter(u => u.id !== this.hostId); if (rem.length) { const oldest = rem.reduce((a, b) => a.joinedAt < b.joinedAt ? a : b); this.setHost(oldest.id); return oldest; } return null; }
  validatePasscode(p) { return !this.passcodeHash || bcrypt.compareSync(p, this.passcodeHash); }
  applyOperation(op, uid) {
    this.documentVersion++; op.version = this.documentVersion; op.userId = uid; op.timestamp = Date.now();
    if (op.type === 'insert') { const p = this.posToIdx(op.position); this.documentContent = this.documentContent.slice(0, p) + op.text + this.documentContent.slice(p); }
    else if (op.type === 'delete') { const s = this.posToIdx(op.position); this.documentContent = this.documentContent.slice(0, s) + this.documentContent.slice(s + op.length); }
    this.operationHistory.push(op); if (this.operationHistory.length > 200) this.operationHistory.shift(); return op;
  }
  posToIdx(pos) { let i = 0; const ls = this.documentContent.split('\n'); for (let l = 0; l < pos.line && l < ls.length; l++) i += ls[l].length + 1; i += Math.min(pos.column, ls[pos.line]?.length || 0); return Math.min(i, this.documentContent.length); }
  idxToPos(idx) { const ls = this.documentContent.split('\n'); let c = 0; for (let l = 0; l < ls.length; l++) { if (c + ls[l].length >= idx) return { line: l, column: idx - c }; c += ls[l].length + 1; } return { line: ls.length - 1, column: ls[ls.length - 1]?.length || 0 }; }
  logActivity(msg, type, uid) { this.activityLog.push({ id: uuidv4(), message: msg, type, userId: uid, timestamp: Date.now() }); if (this.activityLog.length > 200) this.activityLog.shift(); }
  getLog(lim = 50) { return this.activityLog.slice(-lim); }
  toJSON() { return { id: this.id, hostId: this.hostId, hasPasscode: !!this.passcodeHash, userCount: this.users.size, documentVersion: this.documentVersion, createdAt: this.createdAt }; }
}

class Throttle {
  constructor(opts = {}) { this.max = opts.max || 5; this.win = opts.win || 1000; this.b = new Map(); this.p = new Map(); setInterval(() => this.clean(), 60000); }
  check(uid) {
    const n = Date.now(); let b = this.b.get(uid); if (!b || n - b.s > this.win) { b = { c: 0, s: n, v: 0 }; this.b.set(uid, b); }
    let p = this.p.get(uid); if (!p) { p = { c: 0, l: 0, u: 0 }; this.p.set(uid, p); }
    if (p.u > n) return { ok: false, reason: 'penalty', retry: p.u - n };
    b.c++; if (b.c > this.max) { b.v++; p.c++; p.l = n; if (p.c >= 3) { p.u = n + 5000; return { ok: false, reason: 'throttled', retry: 5000, v: p.c }; } return { ok: false, reason: 'rate', retry: this.win - (n - b.s) }; }
    return { ok: true };
  }
  reset(uid) { this.b.delete(uid); this.p.delete(uid); }
  clean() { const n = Date.now(); for (const [k, v] of this.b) if (n - v.s > this.win * 2) this.b.delete(k); for (const [k, v] of this.p) if (n - v.l > 300000 && v.u < n) this.p.delete(k); }
}

const rooms = new Map(); const userSockets = new Map(); const pendingJoins = new Map(); const throttle = new Throttle({ max: 60 });

function createRoom(id, hid, pass) { const r = new Room(id, hid, pass); rooms.set(r.id, r); return r; }
function getRoom(id) { return rooms.get(id?.toUpperCase()); }
function delRoom(id) { rooms.delete(id?.toUpperCase()); }

function broadcast(rid, msg, ex) { const r = rooms.get(rid); if (!r) return; const m = typeof msg === 'string' ? msg : JSON.stringify({ type: msg.type, payload: msg.payload, timestamp: Date.now() }); for (const [uid, u] of r.users) if (uid !== ex && u.socket.readyState === WebSocket.OPEN) u.socket.send(m); }
function send(uid, msg) { const u = userSockets.get(uid); if (u && u.socket.readyState === WebSocket.OPEN) u.socket.send(typeof msg === 'string' ? msg : JSON.stringify({ type: msg.type, payload: msg.payload, timestamp: Date.now() })); }

function handleJoin(ws, uid, pl) {
  if (!pl || typeof pl.userName !== 'string' || !pl.userName.trim()) return;
  const { roomId, userName, passcode } = pl; const rid = roomId?.toUpperCase() || genId();
  let r = getRoom(rid); const isNew = !r; if (isNew) r = createRoom(rid, uid, passcode);
  else if (!r.validatePasscode(passcode)) { 
    pendingJoins.set(uid, { roomId: rid, userName });
    ws.send(JSON.stringify({ type: MessageType.PASSCODE_REQUIRED, payload: { roomId: rid, error: 'Invalid passcode' }, timestamp: Date.now() })); 
    return; 
  }
  pendingJoins.delete(uid);
  const u = new User(uid, userName, ws, isNew ? 'host' : 'participant');
  userSockets.set(uid, u); r.addUser(u);
  send(uid, { type: MessageType.JOIN_ROOM_ACK, payload: { roomId: r.id, userId: uid, role: u.role, documentContent: r.documentContent, documentVersion: r.documentVersion, users: r.getUsers().map(x => x.toJSON()), activityLog: r.getLog(), isHost: u.role === 'host' } });
  broadcast(r.id, { type: MessageType.USER_JOINED, payload: { user: u.toJSON() } }, uid);
  broadcast(r.id, { type: MessageType.ACTIVITY_LOG, payload: { log: r.activityLog[r.activityLog.length - 1] } }, uid);
}

function handleLeave(uid) {
  const u = userSockets.get(uid); if (!u) return;
  for (const [rid, r] of rooms) if (r.users.has(uid)) {
    const was = r.hostId === uid; r.removeUser(uid);
    broadcast(rid, { type: MessageType.USER_LEFT, payload: { userId: uid, userName: u.name } });
    broadcast(rid, { type: MessageType.ACTIVITY_LOG, payload: { log: r.activityLog[r.activityLog.length - 1] } });
    if (was) { const nh = r.transferHost(); if (nh) { broadcast(rid, { type: MessageType.HOST_TRANSFER, payload: { newHostId: nh.id, newHostName: nh.name } }); send(nh.id, { type: MessageType.ROLE_CHANGE, payload: { role: 'host' } }); broadcast(rid, { type: MessageType.ACTIVITY_LOG, payload: { log: { message: `${nh.name} became host`, type: 'host_transfer', userId: nh.id, timestamp: Date.now() } } }); } else delRoom(rid); }
    if (r.users.size === 0) delRoom(rid); break;
  }
  userSockets.delete(uid);
}

function handleEdit(uid, pl) {
  const chk = throttle.check(uid); if (!chk.ok) { send(uid, { type: MessageType.ERROR, payload: { code: 'THROTTLED', message: 'Too many updates. Slow down.', retryAfter: chk.retry } }); return; }
  const u = userSockets.get(uid); if (!u) return;
  let r = null; for (const [, rm] of rooms) if (rm.users.has(uid)) { r = rm; break; } if (!r) return;
  const op = r.applyOperation(pl.operation, uid); u.updateActivity(); broadcast(r.id, { type: MessageType.EDIT_OPERATION, payload: { operation: op } }, uid);
}

function handleCursor(uid, pl) { const u = userSockets.get(uid); if (!u) return; u.cursorPosition = pl.position; u.updateActivity(); let r = null; for (const [, rm] of rooms) if (rm.users.has(uid)) { r = rm; break; } if (!r) return; broadcast(r.id, { type: MessageType.CURSOR_UPDATE, payload: { userId: uid, userName: u.name, position: pl.position, color: u.color } }, uid); }
function handleSelection(uid, pl) { const u = userSockets.get(uid); if (!u) return; u.selection = pl.selection; u.updateActivity(); let r = null; for (const [, rm] of rooms) if (rm.users.has(uid)) { r = rm; break; } if (!r) return; broadcast(r.id, { type: MessageType.SELECTION_UPDATE, payload: { userId: uid, userName: u.name, selection: pl.selection, color: u.color } }, uid); }
function handleTypingStart(uid) { const u = userSockets.get(uid); if (!u) return; u.setTyping(true); u.updateActivity(); let r = null; for (const [, rm] of rooms) if (rm.users.has(uid)) { r = rm; break; } if (!r) return; broadcast(r.id, { type: MessageType.TYPING_START, payload: { userId: uid, userName: u.name } }, uid); }
function handleTypingStop(uid) { const u = userSockets.get(uid); if (!u) return; u.setTyping(false); u.updateActivity(); let r = null; for (const [, rm] of rooms) if (rm.users.has(uid)) { r = rm; break; } if (!r) return; broadcast(r.id, { type: MessageType.TYPING_STOP, payload: { userId: uid } }, uid); }
function handleSync(uid) { const u = userSockets.get(uid); if (!u) return; let r = null; for (const [, rm] of rooms) if (rm.users.has(uid)) { r = rm; break; } if (!r) return; send(uid, { type: MessageType.SYNC_RESPONSE, payload: { documentContent: r.documentContent, documentVersion: r.documentVersion, users: r.getUsers().map(x => x.toJSON()), activityLog: r.getLog() } }); }

function handleMsg(ws, uid, msg) {
  switch (msg.type) {
    case MessageType.JOIN_ROOM: handleJoin(ws, uid, msg.payload); break;
    case MessageType.PASSCODE_VALIDATE: {
      const pending = pendingJoins.get(uid);
      if (pending) handleJoin(ws, uid, { ...pending, passcode: msg.payload?.passcode });
      break;
    }
    case MessageType.LEAVE_ROOM: handleLeave(uid); break;
    case MessageType.EDIT_OPERATION: handleEdit(uid, msg.payload); break;
    case MessageType.CURSOR_UPDATE: handleCursor(uid, msg.payload); break;
    case MessageType.SELECTION_UPDATE: handleSelection(uid, msg.payload); break;
    case MessageType.TYPING_START: handleTypingStart(uid); break;
    case MessageType.TYPING_STOP: handleTypingStop(uid); break;
    case MessageType.SYNC_REQUEST: handleSync(uid); break;
    case MessageType.PING: send(uid, { type: MessageType.PONG, payload: {} }); break;
  }
}

function genId() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let id = ''; for (let i = 0; i < 6; i++) id += c[Math.floor(Math.random() * c.length)]; return id; }

const wss = new WebSocket.Server({ port: PORT });

console.log(`🚀 Collab WebSocket server running on port ${PORT}`);

wss.on('connection', (ws, req) => {
  const uid = uuidv4(); console.log(`Client connected: ${uid}`);
  ws.on('message', (data) => { try { const msg = JSON.parse(data); if (msg?.type) handleMsg(ws, uid, msg); } catch (e) { console.error('Parse error:', e); } });
  ws.on('close', () => { console.log(`Client disconnected: ${uid}`); pendingJoins.delete(uid); handleLeave(uid); throttle.reset(uid); });
  ws.on('error', (err) => console.error(`WS error ${uid}:`, err.message));
  send(uid, { type: MessageType.PONG, payload: { userId: uid } });
});

process.on('SIGINT', () => { console.log('\nShutting down...'); wss.close(() => process.exit(0)); });
