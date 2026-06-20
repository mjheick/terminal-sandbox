'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

// ─── Constants ───────────────────────────────────────────────────────────────
const PORT = 4096;
const MOTD = 'Welcome to the Command Server. Type "help" for available commands.';
const MAX_LINE_LENGTH = 1024;
const SHUTDOWN_TIMEOUT = 5000;
const CRLF = '\r\n';

// ─── Logging ────────────────────────────────────────────────────────────────
function log(sessionId, action) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${sessionId} ${action}`);
}

function sessionDuration(session) {
  return Math.floor((Date.now() - session.connectedAt.getTime()) / 1000);
}

// ─── Session Management ─────────────────────────────────────────────────────
const sessions = new Map();

function createSession(socket) {
  const id = crypto.randomUUID().slice(0, 8);
  const session = {
    socket,
    id,
    buffer: '',
    connectedAt: new Date(),
  };
  sessions.set(socket, session);
  log(id, `CONNECTED from ${socket.remoteAddress}:${socket.remotePort}`);
  return session;
}

function destroySession(socket, reason) {
  const session = sessions.get(socket);
  if (!session) return;
  const duration = sessionDuration(session);
  log(session.id, `DISCONNECTED reason=${reason || 'unknown'} duration=${duration}s`);
  sessions.delete(socket);
}

// ─── Output Helpers ─────────────────────────────────────────────────────────
function send(socket, text) {
  socket.write(text + CRLF);
}

function sendPrompt(socket) {
  socket.write('> ');
}

// ─── Command Parser ─────────────────────────────────────────────────────────
function parseCommand(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const tokens = trimmed.split(/\s+/);
  return { name: tokens[0].toLowerCase(), args: tokens.slice(1) };
}

// ─── Command Registry ───────────────────────────────────────────────────────
const commands = {};

commands.help = (args, session) => {
  return Object.keys(commands).join(CRLF);
};

commands.echo = (args, session) => {
  return args.join(' ');
};

commands.time = (args, session) => {
  return new Date().toISOString();
};

commands.uptime = (args, session) => {
  return String(Math.floor(process.uptime()));
};

commands.quit = (args, session) => {
  log(session.id, `CMD: quit`);
  send(session.socket, 'Goodbye!');
  session.socket.end();
  destroySession(session.socket, 'quit');
  return null;
};

// ─── Command Dispatch ───────────────────────────────────────────────────────
function dispatch(parsed, session) {
  const handler = commands[parsed.name];
  if (!handler) {
    log(session.id, `CMD UNKNOWN: ${parsed.name}`);
    send(session.socket, `Unknown command: ${parsed.name}`);
    sendPrompt(session.socket);
    return;
  }
  try {
    log(session.id, `CMD: ${parsed.name}${parsed.args.length ? ' ' + parsed.args.join(' ') : ''}`);
    const result = handler(parsed.args, session);
    if (result != null && result !== '') {
      send(session.socket, result);
    }
    if (parsed.name !== 'quit') {
      sendPrompt(session.socket);
    }
  } catch (err) {
    log(session.id, `CMD ERROR: ${parsed.name} - ${err.message}`);
    send(session.socket, `Error: ${err.message}`);
    sendPrompt(session.socket);
  }
}

// ─── Line Buffering ─────────────────────────────────────────────────────────

/**
 * Strip telnet IAC (Interpret As Command) sequences from raw data.
 * Telnet clients send binary negotiation bytes (0xFF followed by 2-3 bytes)
 * before any real input. We silently discard them so they don't get parsed
 * as commands.
 */
function stripTelnetIAC(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0xFF && i + 1 < buf.length) {
      const cmd = buf[i + 1];
      if (cmd === 0xFB || cmd === 0xFC || cmd === 0xFD || cmd === 0xFE) {
        // WILL, WONT, DO, DONT — 3 bytes total
        i += 3;
      } else if (cmd === 0xFA) {
        // Subnegotiation — skip until IAC SE (0xFF 0xF0)
        i += 2;
        while (i < buf.length - 1 && !(buf[i] === 0xFF && buf[i + 1] === 0xF0)) {
          i++;
        }
        i += 2; // skip IAC SE
      } else {
        // Other 2-byte commands (including IAC IAC = literal 0xFF)
        i += 2;
      }
    } else {
      out.push(buf[i]);
      i++;
    }
  }
  return Buffer.from(out);
}

function handleData(socket, data) {
  const session = sessions.get(socket);
  if (!session) return;

  // Filter out telnet negotiation bytes before treating as text
  const cleaned = stripTelnetIAC(data);
  if (cleaned.length === 0) return;

  session.buffer += cleaned.toString();

  // Check if buffer exceeds max length without a newline
  if (!session.buffer.includes('\n') && session.buffer.length > MAX_LINE_LENGTH) {
    session.buffer = '';
    send(socket, 'Input line too long');
    sendPrompt(socket);
    return;
  }

  // Split on newline, process complete lines
  const parts = session.buffer.split('\n');
  // Last element is the incomplete line (remainder)
  session.buffer = parts.pop();

  for (const part of parts) {
    // Strip trailing \r for CRLF handling
    const line = part.replace(/\r$/, '');
    const parsed = parseCommand(line);
    if (parsed === null) {
      // Empty/whitespace-only line, just re-prompt
      sendPrompt(socket);
      continue;
    }
    dispatch(parsed, session);
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Server shutting down...');
  server.close();

  // Notify all connected clients
  for (const [socket, session] of sessions) {
    send(socket, 'Server shutting down...');
    socket.end();
  }

  // Force-destroy after timeout
  const timer = setTimeout(() => {
    for (const [socket, session] of sessions) {
      socket.destroy();
    }
    process.exit(0);
  }, SHUTDOWN_TIMEOUT);

  // If all sessions close before the timer, exit early
  const checkEmpty = () => {
    if (sessions.size === 0) {
      clearTimeout(timer);
      process.exit(0);
    }
  };

  // Poll for session cleanup
  const interval = setInterval(() => {
    checkEmpty();
  }, 100);

  // Also check immediately
  checkEmpty();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Connection Handler ─────────────────────────────────────────────────────
function onConnection(socket) {
  const session = createSession(socket);

  // Send MOTD and prompt
  if (MOTD && MOTD.length > 0) {
    send(socket, MOTD);
  }
  sendPrompt(socket);

  // Wire data handling
  socket.on('data', (data) => handleData(socket, data));

  // Wire error and close for cleanup
  socket.on('error', () => destroySession(socket, 'error'));
  socket.on('close', () => destroySession(socket, 'closed'));
}

// ─── TCP Server ─────────────────────────────────────────────────────────────
const server = net.createServer(onConnection);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

server.on('error', (err) => {
  process.stderr.write(`Server error: ${err.message}\n`);
  process.exit(1);
});
