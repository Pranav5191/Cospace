# Collab Workspace

Collab Workspace is a browser based, real time collaborative code and text editor. A user creates a room or joins one using a room ID. People in the same room share a document, see who else is present, and can view remote cursor, selection, typing, and activity information.

The project is a small JavaScript application with two independently run parts:

- A Node.js WebSocket server that manages rooms, participants, passcodes, document state, and broadcasts.
- A Vite powered browser client that renders the interface and embeds the CodeMirror editor.

> **Current scope:** Each room has one shared document named `main.txt`. The app does not currently support creating, renaming, deleting, or switching between multiple files.

## Contents

- [Features](#features)
- [Technology](#technology)
- [Project structure](#project-structure)
- [Requirements](#requirements)
- [Install](#install)
- [Run locally](#run-locally)
- [Use the app](#use-the-app)
- [How collaboration works](#how-collaboration-works)
- [WebSocket protocol](#websocket-protocol)
- [Configuration](#configuration)
- [Build and preview](#build-and-preview)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Development notes](#development-notes)

## Features

### Rooms and participants

- Create a room with a generated six character room ID, or join an existing room with its ID.
- Optionally protect a new room with a passcode. The server stores a bcrypt hash of the passcode in memory.
- See the room ID, connection state, participant list, and activity feed in the workspace.
- Room creators start as the host. If the host leaves while others are present, the participant who joined earliest becomes the new host.
- The server removes a room when its last participant leaves.

### Shared editor

- A CodeMirror editor is synchronized among members of a room.
- JavaScript and Python language support is loaded in the editor.
- The interface displays a document version and a sync state.
- Remote edits are represented as insert and delete operations. A client can request a full document sync from the server.

### Collaboration indicators

- Participant names and roles are shown in the sidebar.
- Participants receive distinct colors used for cursor and selection indicators.
- Cursor positions and selections are broadcast to other room members.
- Typing state is broadcast and expires after a short timeout.
- Join and leave events are written to a bounded activity feed.
- The client sends periodic WebSocket heartbeat messages and attempts a limited number of reconnections after an unexpected disconnect.

## Technology

| Area | Technology |
| --- | --- |
| Server runtime | Node.js |
| Real time transport | WebSocket using `ws` |
| Browser client | Vite and native JavaScript modules |
| Editor | CodeMirror 6 packages |
| Room IDs and log IDs | `uuid` |
| Passcode hashing | `bcryptjs` |

## Project structure

```text
.
├── server/
│   ├── index.js             WebSocket server, room lifecycle, message handlers
│   ├── roomManager.js       Room and participant model implementation
│   └── throttleManager.js   Standalone throttling manager
├── shared/
│   └── protocol.js          Shared message type and protocol helpers
├── client/
│   ├── public/
│   │   ├── index.html       Workspace markup and styles
│   │   └── main.js          Client behavior and CodeMirror integration
│   ├── vite.config.js
│   └── package.json
├── dist/                    Production client build output
├── package.json             Server and root level scripts
└── README.md
```

The active server implementation currently defines its message constants and room classes in `server/index.js`; `shared/protocol.js`, `server/roomManager.js`, and `server/throttleManager.js` are not currently imported by that entry point.

## Requirements

- Node.js 18 or later
- npm
- A modern browser with WebSocket support

## Install

From the project root, install both server and client dependencies:

```sh
npm run install:all
```

This runs `npm install` in the project root and then in `client/`.

## Run locally

Run the server and client in separate terminals from the project root.

**Terminal 1 — WebSocket server:**

```sh
npm start
```

The server listens on port `8081` by default.

**Terminal 2 — Vite client:**

```sh
npm run client
```

Vite serves the client on port `3000`. Open [http://localhost:3000](http://localhost:3000) in your browser.

The client connects directly to `ws://<page-hostname>:8081` for HTTP pages and `wss://<page-hostname>:8081` for HTTPS pages. For local development, keep the web page and WebSocket server reachable on the same host. When using HTTPS in a deployed environment, the WebSocket endpoint must also support TLS (`wss://`), typically through a TLS-enabled reverse proxy.

### Run with custom server port

The server reads the `PORT` environment variable. For example, in PowerShell:

```powershell
$env:PORT = 8081
npm start
```

The browser client currently uses port `8081` directly. If you change the server port, update the `WS_URL` definition near the top of `client/public/main.js` to match, then rebuild/restart the client.

## Use the app

1. Enter a name. Names must be 1–30 characters and may contain letters, numbers, spaces, underscores, and hyphens.
2. To create a new room, optionally enter a passcode and select **Create New**.
3. Share the displayed room ID with the people you want to invite.
4. To join an existing room, enter its room ID and select **Join Room**. If the room is protected, enter its passcode when prompted.
5. Edit the shared `main.txt` document. Other connected participants should see the changes in their editors.
6. Select **Leave** to exit the room.

Room IDs are case insensitive and are displayed in uppercase. Room state exists only while the server process is running and the room has participants.

## How collaboration works

### Connecting and joining

The browser opens a WebSocket connection and sends a `join_room` message with the room ID, name, and optional passcode. The server creates a room if the ID is new; otherwise it checks the existing room’s passcode. A successful join receives a snapshot containing the room ID, user ID, role, document contents and version, participants, and recent activity.

### Editing and synchronization

The client compares the editor’s prior content with its current content and sends the difference as one or more insert/delete operations. The server applies operations to the room’s in-memory document, increments the document version, records the operation, and broadcasts it to the other participants. If a client is throttled, it requests a full document snapshot to resynchronize.

Remote editor transactions are marked so the receiving client does not send the same edit back as a new local edit. The server keeps a bounded recent operation history, but it does not persist that history to disk.

### Presence and activity

Cursor position, selection range, and typing state are sent as independent messages. Join and leave events are added to the room activity log. Participant state and the recent log are included in initial joins and explicit sync responses.

### In-memory limits and throttling

- The server retains up to 200 recent edit operations and 200 activity entries per room.
- Join and synchronization snapshots include the most recent 50 activity entries. The browser activity panel displays up to 50 entries.
- Edit operations are limited to 60 per participant per one-second window. Repeated violations can trigger a five-second penalty. When a client receives a throttling error, it requests a full document snapshot.
- The browser sends a heartbeat every 25 seconds and retries an unexpected disconnect up to five times with increasing delays.

These are in-memory implementation settings, not persisted configuration values.

## WebSocket protocol

Messages are JSON objects with this general shape:

```json
{
  "type": "join_room",
  "payload": {
    "roomId": "ABC123",
    "userName": "Ada",
    "passcode": "optional"
  },
  "timestamp": 1791400000000
}
```

The server and client use message types for these flows:

| Message | Direction | Purpose |
| --- | --- | --- |
| `join_room`, `join_room_ack` | Client ↔ server | Join a room and receive its initial snapshot |
| `passcode_required`, `passcode_validate` | Server ↔ client | Request and validate a protected room passcode |
| `user_joined`, `user_left` | Server → clients | Notify a room when participants arrive or leave |
| `edit_operation` | Client ↔ server | Submit and broadcast an insert/delete edit |
| `cursor_update`, `selection_update` | Client → server → peers | Share editor cursor and selection positions |
| `typing_start`, `typing_stop` | Client → server → peers | Share typing indicators |
| `activity_log` | Server → clients | Add a room activity entry |
| `role_change`, `host_transfer` | Server → clients | Notify participants about host role changes |
| `sync_request`, `sync_response` | Client ↔ server | Request and return a current room snapshot |
| `ping`, `pong` | Client ↔ server | Keep the connection alive |
| `error` | Server → client | Report issues such as edit throttling |

The server’s active transport implementation is in `server/index.js`. `shared/protocol.js` contains a protocol helper module, but the current server and browser client maintain their own message type definitions.

## Configuration

| Setting | Default | Location |
| --- | --- | --- |
| WebSocket server port | `8081` | `PORT` environment variable in `server/index.js` |
| Vite development server port | `3000` | `client/vite.config.js` |
| Client WebSocket host | Current page hostname | `WS_URL` in `client/public/main.js` |
| Client WebSocket port | `8081` | `WS_URL` in `client/public/main.js` |

The WebSocket server currently keeps rooms, documents, participant state, passcode hashes, and logs in process memory. There is no database or persistence configuration.

## Build and preview

Build the browser client from the client directory:

```sh
cd client
npm run build
```

Vite writes the production output to the root `dist/` directory. To preview the built client locally:

```sh
npm run preview
```

The preview server only serves the browser client. The WebSocket server still needs to be started separately with `npm start`.

## Known limitations

- **One file per room:** All participants share a single in-memory `main.txt` document. There is no multi-file explorer or file persistence.
- **No durable storage:** Rooms disappear when the server stops or the final participant leaves.
- **Basic concurrent editing:** Synchronization uses simple insert/delete operations and full-snapshot recovery. It is not based on a CRDT or operational transformation system, so simultaneous edits at the same location may conflict.
- **No accounts:** A participant’s name is not an authenticated identity. Anyone who knows an unprotected room ID can attempt to join.
- **No production access controls:** Passcodes protect room entry but there is no user management, invite system, or role based editing permission model.
- **Single-process rooms:** Room state is local to one Node.js process; multiple server instances will not share room state.
- **No test or lint command:** The package scripts currently provide start, client development, install, build, and preview commands only.

## Troubleshooting

### The page opens, but the room does not connect

- Confirm the WebSocket server is running in another terminal and reports port `8081`.
- Confirm that the client’s hostname and WebSocket endpoint are reachable from the browser.
- Check that another process is not already using port `8081`.
- For an HTTPS deployment, make sure the WebSocket endpoint supports `wss://` through TLS termination.

### Vite reports that port 3000 is in use

Stop the other process using port `3000` or change the Vite server port in `client/vite.config.js`.

### A passcode does not work

Room passcodes are case sensitive. The server does not retain room state after its process stops, so a restarted server no longer has the previous room or passcode.

### A room ID cannot be joined after the server restarts

Rooms are stored only in server memory. Restarting the server clears all room IDs and documents; create a new room and share its new ID.

## Development notes

Useful scripts from the repository root:

| Command | Description |
| --- | --- |
| `npm run install:all` | Install root and client dependencies |
| `npm start` | Start the WebSocket server |
| `npm run dev` | Alias for starting the WebSocket server |
| `npm run client` | Start the Vite browser client on port `3000` |

Useful scripts from `client/`:

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite development server |
| `npm run build` | Build the static production client into `../dist` |
| `npm run preview` | Preview the client production build |
