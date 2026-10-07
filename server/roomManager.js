const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

class User {
  constructor(id, name, socket, role = 'participant') {
    this.id = id;
    this.name = name;
    this.socket = socket;
    this.role = role;
    this.joinedAt = Date.now();
    this.lastActivity = Date.now();
    this.cursorPosition = { line: 0, column: 0 };
    this.selection = null;
    this.isTyping = false;
    this.typingTimeout = null;
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  setTyping(isTyping) {
    this.isTyping = isTyping;
    if (isTyping) {
      if (this.typingTimeout) clearTimeout(this.typingTimeout);
      this.typingTimeout = setTimeout(() => {
        this.isTyping = false;
      }, 3000);
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      joinedAt: this.joinedAt,
      cursorPosition: this.cursorPosition,
      selection: this.selection,
      isTyping: this.isTyping
    };
  }
}

class Room {
  constructor(id, hostId, passcode = null) {
    this.id = id;
    this.passcodeHash = passcode ? bcrypt.hashSync(passcode, 10) : null;
    this.hostId = hostId;
    this.users = new Map();
    this.documentContent = '';
    this.documentVersion = 0;
    this.activityLog = [];
    this.createdAt = Date.now();
    this.pendingOperations = [];
  }

  addUser(user) {
    this.users.set(user.id, user);
    this.logActivity(`${user.name} joined the room`, 'join', user.id);
  }

  removeUser(userId) {
    const user = this.users.get(userId);
    if (user) {
      this.users.delete(userId);
      this.logActivity(`${user.name} left the room`, 'leave', userId);
      return user;
    }
    return null;
  }

  getUser(userId) {
    return this.users.get(userId);
  }

  getUsers() {
    return Array.from(this.users.values());
  }

  getHost() {
    return this.users.get(this.hostId);
  }

  setHost(userId) {
    this.hostId = userId;
    const user = this.users.get(userId);
    if (user) {
      user.role = 'host';
    }
  }

  transferHost() {
    const remainingUsers = this.getUsers().filter(u => u.id !== this.hostId);
    if (remainingUsers.length > 0) {
      const oldestUser = remainingUsers.reduce((oldest, current) => 
        current.joinedAt < oldest.joinedAt ? current : oldest
      );
      this.setHost(oldestUser.id);
      return oldestUser;
    }
    return null;
  }

  validatePasscode(passcode) {
    if (!this.passcodeHash) return true;
    return bcrypt.compareSync(passcode, this.passcodeHash);
  }

  applyOperation(operation, userId) {
    this.documentVersion++;
    operation.version = this.documentVersion;
    operation.userId = userId;
    operation.timestamp = Date.now();
    
    if (operation.type === 'insert') {
      const pos = this.positionToIndex(operation.position);
      this.documentContent = 
        this.documentContent.slice(0, pos) + 
        operation.text + 
        this.documentContent.slice(pos);
    } else if (operation.type === 'delete') {
      const start = this.positionToIndex(operation.position);
      const end = start + operation.length;
      this.documentContent = 
        this.documentContent.slice(0, start) + 
        this.documentContent.slice(end);
    }
    
    this.pendingOperations.push(operation);
    if (this.pendingOperations.length > 100) {
      this.pendingOperations.shift();
    }
    
    return operation;
  }

  positionToIndex(position) {
    let index = 0;
    const lines = this.documentContent.split('\n');
    for (let i = 0; i < position.line && i < lines.length; i++) {
      index += lines[i].length + 1;
    }
    index += Math.min(position.column, lines[position.line]?.length || 0);
    return Math.min(index, this.documentContent.length);
  }

  indexToPosition(index) {
    const lines = this.documentContent.split('\n');
    let currentIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLength = lines[i].length;
      if (currentIndex + lineLength >= index) {
        return { line: i, column: index - currentIndex };
      }
      currentIndex += lineLength + 1;
    }
    return { line: lines.length - 1, column: lines[lines.length - 1]?.length || 0 };
  }

  logActivity(message, type, userId) {
    this.activityLog.push({
      id: uuidv4(),
      message,
      type,
      userId,
      timestamp: Date.now()
    });
    if (this.activityLog.length > 200) {
      this.activityLog.shift();
    }
  }

  getActivityLog(limit = 50) {
    return this.activityLog.slice(-limit);
  }

  toJSON() {
    return {
      id: this.id,
      hostId: this.hostId,
      hasPasscode: !!this.passcodeHash,
      userCount: this.users.size,
      documentVersion: this.documentVersion,
      createdAt: this.createdAt
    };
  }
}

module.exports = { User, Room };