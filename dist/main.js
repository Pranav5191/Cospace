import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap } from '@codemirror/view';

const WS_URL = `ws://${location.hostname}:8080`;

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

class CollabClient {
  constructor() {
    this.ws = null; this.userId = null; this.roomId = null; this.userName = null;
    this.isHost = false; this.docVersion = 0; this.lastContent = '';
    this.remoteCursors = new Map(); this.remoteSelections = new Map();
    this.typingUsers = new Set(); this.reconnectAttempts = 0; this.maxReconnects = 5;
    this.heartbeat = null; this.editorView = null; this.isComposing = false;
    this.typingStopTimer = null; this.pendingOps = []; this.ackVersion = 0;
    this.userColorMap = new Map();
    this.colors = ['#00d4aa', '#6366f1', '#fbbf24', '#f87171', '#a855f7', '#f97316', '#06b6d4', '#ec4899'];
    this.colorIdx = 0;
  }

  init() {
    this.bindEvents(); this.loadSaved();
    this.initBackground();
  }

  loadSaved() {
    const n = localStorage.getItem('cw_username');
    if (n) document.getElementById('user-name').value = n;
  }

  bindEvents() {
    document.getElementById('join-form').addEventListener('submit', e => { e.preventDefault(); this.handleJoin(); });
    document.getElementById('create-btn').addEventListener('click', () => this.handleJoin(true));
    document.getElementById('join-btn').addEventListener('click', () => this.handleJoin(false));
    document.getElementById('leave-btn').addEventListener('click', () => this.leave());
    document.getElementById('copy-room-btn').addEventListener('click', () => this.copyRoomId());
    document.getElementById('copy-room-btn-2').addEventListener('click', () => this.copyRoomId());
    document.getElementById('submit-passcode').addEventListener('click', () => this.submitPasscode());
    document.getElementById('cancel-passcode').addEventListener('click', () => this.hidePasscodeModal());
    document.getElementById('modal-passcode').addEventListener('keypress', e => { if (e.key === 'Enter') this.submitPasscode(); });
    document.getElementById('room-id').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
  }

  initBackground() {
    const canvas = document.getElementById('bg-canvas');
    const ctx = canvas.getContext('2d');
    let particles = [];
    const resize = () => { canvas.width = innerWidth; canvas.height = innerHeight; };
    const createParticles = () => {
      particles = [];
      const count = Math.min(60, Math.floor((innerWidth * innerHeight) / 15000));
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * innerWidth, y: Math.random() * innerHeight,
          vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
          size: Math.random() * 2 + 0.5, opacity: Math.random() * 0.4 + 0.1,
          color: ['#00d4aa', '#6366f1', '#a855f7'][Math.floor(Math.random() * 3)]
        });
      }
    };
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = canvas.width; if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height; if (p.y > canvas.height) p.y = 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + Math.floor(p.opacity * 255).toString(16).padStart(2, '0');
        ctx.fill();
      });
      particles.forEach((p1, i) => {
        particles.slice(i + 1).forEach(p2 => {
          const dx = p1.x - p2.x, dy = p1.y - p2.y, dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = p1.color + Math.floor((1 - dist / 120) * 0.15 * 255).toString(16).padStart(2, '0');
            ctx.lineWidth = 0.5; ctx.stroke();
          }
        });
      });
      requestAnimationFrame(animate);
    };
    window.addEventListener('resize', () => { resize(); createParticles(); });
    resize(); createParticles(); animate();
  }

  async handleJoin(createNew = false) {
    const name = document.getElementById('user-name').value.trim();
    const roomId = createNew ? '' : document.getElementById('room-id').value.trim().toUpperCase();
    const passcode = document.getElementById('room-passcode').value;

    if (!name) return this.showJoinError('Please enter your name');
    if (!/^[a-zA-Z0-9_\-\s]{1,30}$/.test(name)) return this.showJoinError('Name must be 1-30 chars (letters, numbers, _ - space)');

    this.userName = name; localStorage.setItem('cw_username', name);
    this.hideJoinError(); this.connect(roomId || this.genRoomId(), passcode);
  }

  genRoomId() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = ''; for (let i = 0; i < 6; i++) id += c[Math.floor(Math.random() * c.length)];
    return id;
  }

  connect(roomId, passcode = '') {
    this.roomId = roomId.toUpperCase(); this.setConnecting();
    this.ws = new WebSocket(WS_URL);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('WS connected'); this.reconnectAttempts = 0; this.setConnected();
      this.send({ type: MessageType.JOIN_ROOM, payload: { roomId: this.roomId, userName: this.userName, passcode } });
      this.startHeartbeat();
    };

    this.ws.onmessage = e => {
      try { const msg = JSON.parse(e.data); this.handleMsg(msg); } catch (err) { console.error('Parse error:', err); }
    };

    this.ws.onclose = () => { console.log('WS closed'); this.setDisconnected(); this.stopHeartbeat(); this.attemptReconnect(roomId, passcode); };
    this.ws.onerror = e => console.error('WS error:', e);
  }

  attemptReconnect(roomId, passcode) {
    if (this.reconnectAttempts < this.maxReconnects) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts - 1), 10000);
      console.log(`Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnects})`);
      setTimeout(() => this.connect(roomId, passcode), delay);
    } else {
      this.showJoinError('Connection lost. Please refresh the page.');
      this.showJoinScreen();
    }
  }

  startHeartbeat() { this.heartbeat = setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: MessageType.PING }); }, 25000); }
  stopHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }

  send(msg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  handleMsg(msg) {
    switch (msg.type) {
      case MessageType.JOIN_ROOM_ACK: this.handleJoinAck(msg.payload); break;
      case MessageType.USER_JOINED: this.addParticipant(msg.payload.user); break;
      case MessageType.USER_LEFT: this.removeParticipant(msg.payload.userId); break;
      case MessageType.EDIT_OPERATION: this.applyRemoteOp(msg.payload.operation); break;
      case MessageType.CURSOR_UPDATE: this.updateRemoteCursor(msg.payload); break;
      case MessageType.SELECTION_UPDATE: this.updateRemoteSelection(msg.payload); break;
      case MessageType.TYPING_START: this.setTyping(msg.payload.userId, true); break;
      case MessageType.TYPING_STOP: this.setTyping(msg.payload.userId, false); break;
      case MessageType.ACTIVITY_LOG: this.addActivity(msg.payload.log); break;
      case MessageType.ROLE_CHANGE: this.isHost = msg.payload.role === 'host'; this.updateUIRole(); break;
      case MessageType.HOST_TRANSFER: this.addActivity({ message: `${msg.payload.newHostName} became host`, type: 'host_transfer', userId: msg.payload.newHostId, timestamp: Date.now() }); break;
      case MessageType.ERROR: this.handleError(msg.payload); break;
      case MessageType.PASSCODE_REQUIRED: this.showPasscodeModal(msg.payload.error); break;
      case MessageType.SYNC_RESPONSE: this.handleSync(msg.payload); break;
      case MessageType.PONG: break;
    }
  }

  handleJoinAck(p) {
    this.userId = p.userId; this.isHost = p.isHost; this.docVersion = p.documentVersion; this.ackVersion = p.documentVersion;
    this.showApp(); this.initEditor(p.documentContent); this.updateRoomBadge(); this.renderParticipants(p.users); this.renderActivity(p.activityLog);
  }

  handleSync(p) {
    this.editorView.dispatch({ changes: { from: 0, to: this.editorView.state.doc.length, insert: p.documentContent } });
    this.docVersion = p.documentVersion; this.ackVersion = p.documentVersion; this.lastContent = p.documentContent;
    this.renderParticipants(p.users); this.renderActivity(p.activityLog); this.setSynced();
  }

  initEditor(content) {
    const ext = [
      basicSetup, javascript(), python(), oneDark,
      EditorView.updateListener.of(u => this.onEditorUpdate(u)),
      keymap.of([{ key: 'Tab', run: v => { v.dispatch({ changes: { from: v.state.selection.main.head, insert: '  ' } }); return true; } }])
    ];
    this.editorView = new EditorView({ state: EditorState.create({ doc: content, extensions }), parent: document.getElementById('editor') });
    this.lastContent = content;
    this.editorView.contentDOM.addEventListener('compositionstart', () => this.isComposing = true);
    this.editorView.contentDOM.addEventListener('compositionend', () => { this.isComposing = false; this.checkChanges(); });
    this.editorView.contentDOM.addEventListener('selectionchange', () => { this.sendCursor(); this.sendSelection(); });
  }

  onEditorUpdate(u) {
    if (u.docChanged && !this.isComposing) this.checkChanges();
    if (u.selectionSet) { this.sendCursor(); this.sendSelection(); }
  }

  checkChanges() {
    const cur = this.editorView.state.doc.toString();
    if (cur !== this.lastContent) { this.sendEdit(cur); this.lastContent = cur; }
  }

  sendEdit(newContent) {
    const old = this.lastContent; const ops = this.diff(old, newContent);
    ops.forEach(op => this.send({ type: MessageType.EDIT_OPERATION, payload: { operation: op } }));
  }

  diff(oldStr, newStr) {
    const ops = []; let cs = 0, min = Math.min(oldStr.length, newStr.length);
    while (cs < min && oldStr[cs] === newStr[cs]) cs++;
    let ce = 0;
    while (ce < min - cs && oldStr[oldStr.length - 1 - ce] === newStr[newStr.length - 1 - ce]) ce++;
    const delLen = oldStr.length - cs - ce;
    const insText = newStr.slice(cs, newStr.length - ce);
    const doc = this.editorView.state.doc;
    if (delLen > 0) ops.push({ type: 'delete', position: this.offsetToPos(cs, doc), length: delLen });
    if (insText.length > 0) ops.push({ type: 'insert', position: this.offsetToPos(cs, doc), text: insText });
    return ops;
  }

  offsetToPos(offset, doc) {
    let line = 1, cur = 0;
    while (line <= doc.lines) { const len = doc.line(line).length; if (cur + len >= offset) return { line: line - 1, column: offset - cur }; cur += len + 1; line++; }
    const ll = doc.line(doc.lines); return { line: doc.lines - 1, column: ll.length };
  }

  posToOffset(pos, doc) {
    let off = 0; for (let i = 0; i < pos.line && i < doc.lines; i++) off += doc.line(i + 1).length + 1;
    off += Math.min(pos.column, doc.line(pos.line + 1)?.length || 0); return Math.min(off, doc.length);
  }

  applyRemoteOp(op) {
    if (op.userId === this.userId) return;
    const doc = this.editorView.state.doc; const changes = [];
    if (op.type === 'insert') { const p = this.posToOffset(op.position, doc); changes.push({ from: p, insert: op.text }); }
    else if (op.type === 'delete') { const f = this.posToOffset(op.position, doc); changes.push({ from: f, to: f + op.length }); }
    if (changes.length) this.editorView.dispatch({ changes, annotations: [RemoteAnnotation.define(op.userId)] });
    this.docVersion = op.version; this.ackVersion = op.version; this.updateVersion();
  }

  sendCursor() {
    const sel = this.editorView.state.selection.main; const doc = this.editorView.state.doc;
    const line = doc.lineAt(sel.head); this.send({ type: MessageType.CURSOR_UPDATE, payload: { position: { line: line.number - 1, column: sel.head - line.from } } });
  }

  sendSelection() {
    const sel = this.editorView.state.selection.main; const doc = this.editorView.state.doc;
    if (sel.empty) { this.send({ type: MessageType.SELECTION_UPDATE, payload: { selection: null } }); return; }
    const fl = doc.lineAt(sel.from), tl = doc.lineAt(sel.to);
    this.send({ type: MessageType.SELECTION_UPDATE, payload: { selection: { from: { line: fl.number - 1, column: sel.from - fl.from }, to: { line: tl.number - 1, column: sel.to - tl.from } } } });
  }

  sendTyping() { this.send({ type: MessageType.TYPING_START }); if (this.typingStopTimer) clearTimeout(this.typingStopTimer); this.typingStopTimer = setTimeout(() => this.send({ type: MessageType.TYPING_STOP }), 800); }

  updateRemoteCursor(p) {
    if (p.userId === this.userId) return;
    const off = this.posToOffset(p.position, this.editorView.state.doc);
    const coords = this.editorView.coordsAtPos(off); if (!coords) return;
    let el = this.remoteCursors.get(p.userId);
    if (!el) { el = document.createElement('div'); el.className = 'remote-cursor'; el.style.background = p.color; const lbl = document.createElement('div'); lbl.className = 'remote-cursor-label'; lbl.style.background = p.color; lbl.textContent = p.userName; el.appendChild(lbl); this.editorView.scrollDOM.appendChild(el); this.remoteCursors.set(p.userId, el); }
    el.style.left = coords.left + 'px'; el.style.top = coords.top + 'px'; el.style.height = (coords.bottom - coords.top) + 'px';
  }

  updateRemoteSelection(p) {
    if (p.userId === this.userId) return;
    if (!p.selection) { this.removeRemoteSel(p.userId); return; }
    const f = this.posToOffset(p.selection.from, this.editorView.state.doc);
    const t = this.posToOffset(p.selection.to, this.editorView.state.doc);
    const fc = this.editorView.coordsAtPos(f), tc = this.editorView.coordsAtPos(t); if (!fc || !tc) return;
    let el = this.remoteSelections.get(p.userId);
    if (!el) { el = document.createElement('div'); el.className = 'remote-selection'; el.style.background = p.color; this.editorView.scrollDOM.appendChild(el); this.remoteSelections.set(p.userId, el); }
    el.style.left = fc.left + 'px'; el.style.top = fc.top + 'px'; el.style.width = Math.max(2, tc.left - fc.left) + 'px'; el.style.height = Math.max(tc.bottom - fc.top, fc.bottom - fc.top) + 'px';
  }

  removeRemoteSel(id) { const el = this.remoteSelections.get(id); if (el) { el.remove(); this.remoteSelections.delete(id); } }

  setTyping(uid, on) {
    if (on) this.typingUsers.add(uid); else this.typingUsers.delete(uid);
    const el = document.querySelector(`[data-uid="${uid}"]`); if (!el) return;
    let ti = el.querySelector('.typing-indicator');
    if (on) { if (!ti) { ti = document.createElement('span'); ti.className = 'typing-indicator'; ti.innerHTML = '<span>.</span><span>.</span><span>.</span>'; el.querySelector('.participant-meta').appendChild(ti); } }
    else if (ti) ti.remove();
  }

  addParticipant(u) {
    const list = document.getElementById('participants-list');
    if (list.querySelector(`[data-uid="${u.id}"]`)) return;
    const el = document.createElement('div'); el.className = `participant ${u.role === 'host' ? 'host' : ''} ${u.id === this.userId ? 'current' : ''}`; el.dataset.uid = u.id;
    const initials = u.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    el.innerHTML = `<div class="participant-avatar" style="background:${u.color}">${initials}</div><div class="participant-info"><div class="participant-name">${this.esc(u.name)}${u.id === this.userId ? ' <span class="you-label">You</span>' : ''}</div><div class="participant-meta"><span class="role-badge ${u.role}">${u.role}</span></div></div>`;
    list.appendChild(el); this.updateCount();
  }

  removeParticipant(uid) {
    const el = document.querySelector(`[data-uid="${uid}"]`); if (el) el.remove();
    this.removeRemoteCursor(uid); this.removeRemoteSel(uid); this.typingUsers.delete(uid); this.updateCount();
  }

  removeRemoteCursor(uid) { const el = this.remoteCursors.get(uid); if (el) { el.remove(); this.remoteCursors.delete(uid); } }

  updateCount() { document.getElementById('participant-count').textContent = document.querySelectorAll('#participants-list .participant').length; }

  renderParticipants(users) { document.getElementById('participants-list').innerHTML = ''; users.forEach(u => this.addParticipant(u)); }

  updateUIRole() { if (this.userId) { const el = document.querySelector(`[data-uid="${this.userId}"]`); if (el) { el.classList.toggle('host', this.isHost); const rb = el.querySelector('.role-badge'); if (rb) { rb.textContent = this.isHost ? 'host' : 'participant'; rb.className = `role-badge ${this.isHost ? 'host' : 'participant'}`; } } } }

  addActivity(log) {
    const feed = document.getElementById('activity-feed');
    const el = document.createElement('div'); el.className = 'activity-item';
    const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const icons = { join: '➤', leave: '✦', edit: '✎', host_transfer: '⛶', typing: '⌨' };
    el.innerHTML = `<div class="activity-icon ${log.type}">${icons[log.type] || '•'}</div><div class="activity-content"><div class="activity-message">${this.esc(log.message)}</div><div class="activity-time">${time}</div></div>`;
    feed.prepend(el); while (feed.children.length > 50) feed.lastChild.remove();
  }

  renderActivity(logs) { document.getElementById('activity-feed').innerHTML = ''; logs.forEach(l => this.addActivity(l)); }

  updateRoomBadge() { const b = document.getElementById('room-id-display'); b.textContent = this.roomId; document.getElementById('room-badge').classList.toggle('locked', !!document.getElementById('room-passcode').value); }

  updateVersion() { document.getElementById('doc-version').textContent = this.docVersion; }

  setSynced() { const s = document.getElementById('sync-status'); s.className = 'sync-status synced'; s.querySelector('span:last-child').textContent = 'Synced'; }
  setSyncing() { const s = document.getElementById('sync-status'); s.className = 'sync-status syncing'; s.querySelector('span:last-child').textContent = 'Syncing…'; }
  setConnected() { const d = document.getElementById('status-dot'); const t = document.getElementById('status-text'); d.className = 'status-dot connected'; t.textContent = 'Connected'; }
  setConnecting() { const d = document.getElementById('status-dot'); const t = document.getElementById('status-text'); d.className = 'status-dot connecting'; t.textContent = 'Connecting…'; }
  setDisconnected() { const d = document.getElementById('status-dot'); const t = document.getElementById('status-text'); d.className = 'status-dot error'; t.textContent = 'Disconnected'; }

  handleError(p) { if (p.code === 'THROTTLED') { this.setSyncing(); setTimeout(() => this.setSynced(), 3000); } else console.error('Error:', p); }

  showPasscodeModal(err) { const m = document.getElementById('passcode-modal'); const e = document.getElementById('passcode-error'); if (err) { e.querySelector('span').textContent = err; e.classList.add('visible'); } else e.classList.remove('visible'); m.classList.remove('hidden'); setTimeout(() => m.classList.add('active'), 10); document.getElementById('modal-passcode').focus(); }
  hidePasscodeModal() { const m = document.getElementById('passcode-modal'); m.classList.remove('active'); setTimeout(() => m.classList.add('hidden'), 200); document.getElementById('modal-passcode').value = ''; }
  submitPasscode() { this.send({ type: MessageType.PASSCODE_VALIDATE, payload: { passcode: document.getElementById('modal-passcode').value } }); this.hidePasscodeModal(); }

  copyRoomId() { if (this.roomId) { navigator.clipboard.writeText(this.roomId); const btn = document.getElementById('copy-room-btn'); const orig = btn.innerHTML; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>'; setTimeout(() => btn.innerHTML = orig, 1500); } }

  leave() { this.send({ type: MessageType.LEAVE_ROOM }); this.cleanup(); this.showJoinScreen(); }

  cleanup() { this.stopHeartbeat(); if (this.ws) { this.ws.close(); this.ws = null; } this.remoteCursors.forEach(e => e.remove()); this.remoteCursors.clear(); this.remoteSelections.forEach(e => e.remove()); this.remoteSelections.clear(); this.typingUsers.clear(); if (this.editorView) { this.editorView.destroy(); this.editorView = null; } }

  showApp() { document.getElementById('join-screen').classList.add('hidden'); document.getElementById('app').classList.remove('hidden'); }
  showJoinScreen() { document.getElementById('app').classList.add('hidden'); document.getElementById('join-screen').classList.remove('hidden'); }
  showJoinError(m) { const e = document.getElementById('join-error'); const t = document.getElementById('join-error-text'); t.textContent = m; e.classList.add('visible'); }
  hideJoinError() { document.getElementById('join-error').classList.remove('visible'); }
  esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
}

const RemoteAnnotation = EditorState.AnnotationType.define();

new CollabClient().init();