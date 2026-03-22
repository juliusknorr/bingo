import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

// --- Persistence ---

function saveSessions() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [id, s] of sessions) {
      obj[id] = {
        id: s.id,
        hostId: s.hostId,
        phase: s.phase,
        phrases: s.phrases,
        winner: s.winner,
        lastActivity: s.lastActivity.toISOString(),
        players: [...s.players.entries()].map(([pid, p]) => ({
          pid,
          name: p.name,
          card: p.card,
          ticked: [...p.ticked],
          bingo: p.bingo,
        })),
      };
    }
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch (e) {
    console.error('Failed to save sessions:', e);
  }
}

function loadSessions() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const raw = readFileSync(SESSIONS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const map = new Map();
    for (const [id, s] of Object.entries(obj)) {
      const players = new Map();
      for (const p of s.players) {
        players.set(p.pid, {
          pid: p.pid,
          name: p.name,
          card: p.card,
          ticked: new Set(p.ticked),
          bingo: p.bingo,
          socketId: null,
        });
      }
      map.set(id, {
        id: s.id,
        hostId: s.hostId,
        phase: s.phase,
        phrases: s.phrases,
        winner: s.winner,
        lastActivity: new Date(s.lastActivity),
        players,
        pidToSocket: new Map(), // ephemeral: pid -> socketId
      });
    }
    console.log(`Loaded ${map.size} session(s) from disk`);
    return map;
  } catch {
    return new Map();
  }
}

// In-memory session store (pre-loaded from disk)
const sessions = loadSessions();

// --- Helpers ---

function generateId(len = 6) {
  return Math.random().toString(36).substring(2, 2 + len).toUpperCase();
}

function uniqueName(name, players) {
  const names = [...players.values()].map(p => p.name);
  if (!names.includes(name)) return name;
  let i = 2;
  while (names.includes(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCard(phrases) {
  return fisherYates(phrases).slice(0, 25);
}

function checkBingo(ticked) {
  const t = (i) => ticked.has(i);
  for (let r = 0; r < 5; r++) {
    if ([0,1,2,3,4].every(c => t(r * 5 + c))) return true;
  }
  for (let c = 0; c < 5; c++) {
    if ([0,1,2,3,4].every(r => t(r * 5 + c))) return true;
  }
  if ([0,6,12,18,24].every(i => t(i))) return true;
  if ([4,8,12,16,20].every(i => t(i))) return true;
  return false;
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastActivity = new Date();
  return s;
}

function playersToPublic(session) {
  return [...session.players.entries()].map(([pid, p]) => ({
    id: pid,
    name: p.name,
    bingo: p.bingo,
    tickedCount: p.ticked.size,
  }));
}

function promoteHost(session) {
  const nextPid = [...session.players.entries()]
    .find(([pid, p]) => p.socketId !== null)?.[0];
  if (nextPid) {
    session.hostId = nextPid;
    io.to(session.id).emit('host_changed', { newHostId: nextPid });
    saveSessions();
  }
}

// --- Routes ---

app.use(express.static(join(__dirname, 'public')));

app.get('/join/:sessionId', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// --- Socket.io ---

io.on('connection', (socket) => {
  let currentSessionId = null;
  let myPid = null;

  socket.on('create_session', ({ playerName, pid }) => {
    myPid = pid;
    const sessionId = generateId();
    const name = playerName?.trim() || 'Spieler';
    const player = { pid, name, card: null, ticked: new Set(), bingo: false, socketId: socket.id };
    const session = {
      id: sessionId,
      hostId: pid,
      phase: 'LOBBY',
      players: new Map([[pid, player]]),
      phrases: [],
      winner: null,
      lastActivity: new Date(),
      pidToSocket: new Map([[pid, socket.id]]),
    };
    sessions.set(sessionId, session);
    currentSessionId = sessionId;
    socket.join(sessionId);
    saveSessions();

    socket.emit('session_joined', {
      sessionId,
      playerId: pid,
      hostId: session.hostId,
      isHost: true,
      phase: session.phase,
      players: playersToPublic(session),
      phrases: [],
    });
  });

  socket.on('join_session', ({ sessionId, playerName, pid }) => {
    myPid = pid;
    const session = getSession(sessionId?.toUpperCase());
    if (!session) {
      socket.emit('error', { message: 'Sitzung nicht gefunden.' });
      return;
    }

    let player = session.players.get(pid);
    if (player) {
      // Reconnect: restore this socket to the existing player
      player.socketId = socket.id;
      // Tell other clients this player is back (they removed them on disconnect)
      socket.to(session.id).emit('player_joined', {
        player: { id: pid, name: player.name, bingo: player.bingo },
      });
    } else {
      // New player joining
      if (session.phase === 'FINISHED') {
        socket.emit('error', { message: 'Dieses Spiel ist bereits beendet.' });
        return;
      }
      const name = uniqueName(playerName?.trim() || 'Spieler', session.players);
      const card = session.phase === 'PLAYING' ? generateCard(session.phrases) : null;
      player = { pid, name, card, ticked: new Set(), bingo: false, socketId: socket.id };
      session.players.set(pid, player);
      saveSessions();
      socket.to(session.id).emit('player_joined', {
        player: { id: pid, name, bingo: false },
      });
    }

    session.pidToSocket.set(pid, socket.id);
    currentSessionId = session.id;
    socket.join(session.id);

    const response = {
      sessionId: session.id,
      playerId: pid,
      hostId: session.hostId,
      isHost: session.hostId === pid,
      phase: session.phase,
      players: playersToPublic(session),
      phrases: session.phrases,
    };

    // Include full game state so the client can restore after a reconnect
    if (session.phase === 'PLAYING' || session.phase === 'FINISHED') {
      response.cards = Object.fromEntries(
        [...session.players.entries()].map(([p, pl]) => [p, pl.card])
      );
      response.ticked = Object.fromEntries(
        [...session.players.entries()].map(([p, pl]) => [p, [...pl.ticked]])
      );
      response.winner = session.winner;
      response.winnerName = session.players.get(session.winner)?.name || '';
    }

    socket.emit('session_joined', response);
  });

  socket.on('add_phrase', ({ phrase }) => {
    const session = getSession(currentSessionId);
    if (!session || session.phase !== 'COLLECTING') return;
    const p = phrase?.trim();
    if (!p || session.phrases.includes(p)) return;
    session.phrases.push(p);
    io.to(session.id).emit('phrases_updated', { phrases: session.phrases });
    saveSessions();
  });

  socket.on('remove_phrase', ({ phraseIndex }) => {
    const session = getSession(currentSessionId);
    if (!session || session.phase !== 'COLLECTING') return;
    if (session.hostId !== myPid) return;
    if (phraseIndex < 0 || phraseIndex >= session.phrases.length) return;
    session.phrases.splice(phraseIndex, 1);
    io.to(session.id).emit('phrases_updated', { phrases: session.phrases });
    saveSessions();
  });

  socket.on('start_collecting', () => {
    const session = getSession(currentSessionId);
    if (!session || session.hostId !== myPid) return;
    if (session.phase !== 'LOBBY') return;
    session.phase = 'COLLECTING';
    io.to(session.id).emit('phase_changed', { phase: 'COLLECTING' });
    saveSessions();
  });

  socket.on('start_game', () => {
    const session = getSession(currentSessionId);
    if (!session || session.hostId !== myPid) return;
    if (session.phase !== 'COLLECTING') return;
    if (session.phrases.length < 25) return;

    session.phase = 'PLAYING';
    const cards = {};
    for (const [pid, player] of session.players) {
      player.card = generateCard(session.phrases);
      player.ticked = new Set();
      player.bingo = false;
      cards[pid] = player.card;
    }
    session.winner = null;
    saveSessions();

    io.to(session.id).emit('phase_changed', { phase: 'PLAYING' });
    io.to(session.id).emit('game_started', { cards });
  });

  socket.on('tick_field', ({ index }) => {
    const session = getSession(currentSessionId);
    if (!session || session.phase !== 'PLAYING') return;
    const player = session.players.get(myPid);
    if (!player) return;
    if (index < 0 || index > 24) return;

    const wasTicked = player.ticked.has(index);
    if (wasTicked) {
      player.ticked.delete(index);
    } else {
      player.ticked.add(index);
    }
    saveSessions();

    io.to(session.id).emit('field_ticked', {
      playerId: myPid,
      index,
      ticked: !wasTicked,
    });

    if (!wasTicked && checkBingo(player.ticked) && !player.bingo) {
      player.bingo = true;
      session.winner = myPid;
      session.phase = 'FINISHED';
      saveSessions();
      io.to(session.id).emit('bingo', {
        winnerId: myPid,
        winnerName: player.name,
      });
    }
  });

  socket.on('restart_game', () => {
    const session = getSession(currentSessionId);
    if (!session || session.hostId !== myPid) return;

    session.phase = 'COLLECTING';
    session.phrases = [];
    session.winner = null;
    for (const player of session.players.values()) {
      player.card = null;
      player.ticked = new Set();
      player.bingo = false;
    }
    saveSessions();

    io.to(session.id).emit('phase_changed', { phase: 'COLLECTING' });
    io.to(session.id).emit('phrases_updated', { phrases: [] });
  });

  socket.on('disconnect', () => {
    if (!currentSessionId || !myPid) return;
    const session = sessions.get(currentSessionId);
    if (!session) return;

    const player = session.players.get(myPid);
    if (player) player.socketId = null;
    session.pidToSocket.delete(myPid);

    io.to(session.id).emit('player_left', { playerId: myPid });

    if (session.hostId === myPid) {
      promoteHost(session);
    }
  });
});

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS);
  for (const [id, session] of sessions) {
    if (session.lastActivity < cutoff) {
      sessions.delete(id);
    }
  }
  saveSessions();
}, 5 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`Bingo server running on http://localhost:${PORT}`);
});
