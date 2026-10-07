const MessageType = {
  JOIN_ROOM: 'join_room',
  JOIN_ROOM_ACK: 'join_room_ack',
  LEAVE_ROOM: 'leave_room',
  ROOM_STATE: 'room_state',
  USER_JOINED: 'user_joined',
  USER_LEFT: 'user_left',
  EDIT_OPERATION: 'edit_operation',
  CURSOR_UPDATE: 'cursor_update',
  SELECTION_UPDATE: 'selection_update',
  TYPING_START: 'typing_start',
  TYPING_STOP: 'typing_stop',
  ACTIVITY_LOG: 'activity_log',
  ROLE_CHANGE: 'role_change',
  HOST_TRANSFER: 'host_transfer',
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',
  PASSCODE_REQUIRED: 'passcode_required',
  PASSCODE_VALIDATE: 'passcode_validate',
  PASSCODE_RESULT: 'passcode_result',
  SYNC_REQUEST: 'sync_request',
  SYNC_RESPONSE: 'sync_response'
};

const UserRole = {
  HOST: 'host',
  PARTICIPANT: 'participant'
};

const EditOperationType = {
  INSERT: 'insert',
  DELETE: 'delete',
  RETAIN: 'retain'
};

function createMessage(type, payload = {}) {
  return JSON.stringify({ type, payload, timestamp: Date.now() });
}

function parseMessage(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

module.exports = {
  MessageType,
  UserRole,
  EditOperationType,
  createMessage,
  parseMessage
};