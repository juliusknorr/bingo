import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// In-memory session store
const sessions = new Map();

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
  // ticked is a Set of indices 0-24, grid is 5x5
  const t = (i) => ticked.has(i);

  // Rows
  for (let r = 0; r < 5; r++) {
    if ([0,1,2,3,4].every(c => t(r * 5 + c))) return true;
  }
  // Columns
  for (let c = 0; c < 5; c++) {
    if ([0,1,2,3,4].every(r => t(r * 5 + c))) return true;
  }
  // Diagonals
  if ([0,6,12,18,24].every(i => t(i))) return true;
  if ([4,8,12,16,20].every(i => t(i))) return true;

  return false;
}

function sessionToPublic(session) {
  return {
    id: session.id,
    phase: session.phase,
    hostId: session.hostId,
    players: [...session.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      bingo: p.bingo,
      tickedCount: p.ticked.size,
    })),
    phrases: session.phrases,
    winner: session.winner,
  };
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastActivity = new Date();
  return s;
}

function promoteHost(session) {
  const next = session.players.keys().next().value;
  if (next) {
    session.hostId = next;
    io.to(session.id).emit('host_changed', { newHostId: next });
  }
}

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// Deep-link route: /join/:sessionId
app.get('/join/:sessionId', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Socket.io
io.on('connection', (socket) => {
  let currentSessionId = null;

  socket.on('create_session', ({ playerName }) => {
    const sessionId = generateId();
    const session = {
      id: sessionId,
      hostId: socket.id,
      phase: 'LOBBY',
      players: new Map(),
      phrases: [],
      winner: null,
      lastActivity: new Date(),
    };
    const name = playerName?.trim() || 'Spieler';
    session.players.set(socket.id, {
      id: socket.id,
      name,
      card: null,
      ticked: new Set(),
      bingo: false,
    });
    sessions.set(sessionId, session);
    currentSessionId = sessionId;
    socket.join(sessionId);

    socket.emit('session_joined', {
      sessionId,
      playerId: socket.id,
      isHost: true,
      phase: session.phase,
      players: [...session.players.entries()].map(([id, p]) => ({ id, name: p.name, bingo: p.bingo })),
      phrases: session.phrases,
    });
  });

  socket.on('join_session', ({ sessionId, playerName }) => {
    const session = getSession(sessionId?.toUpperCase());
    if (!session) {
      socket.emit('error', { message: 'Sitzung nicht gefunden.' });
      return;
    }
    if (session.phase === 'FINISHED') {
      socket.emit('error', { message: 'Dieses Spiel ist bereits beendet.' });
      return;
    }

    const name = uniqueName(playerName?.trim() || 'Spieler', session.players);
    session.players.set(socket.id, {
      id: socket.id,
      name,
      card: null,
      ticked: new Set(),
      bingo: false,
    });
    currentSessionId = session.id;
    socket.join(session.id);

    socket.emit('session_joined', {
      sessionId: session.id,
      playerId: socket.id,
      isHost: session.hostId === socket.id,
      phase: session.phase,
      players: [...session.players.entries()].map(([id, p]) => ({ id, name: p.name, bingo: p.bingo })),
      phrases: session.phrases,
    });

    socket.to(session.id).emit('player_joined', {
      player: { id: socket.id, name, bingo: false },
    });
  });

  socket.on('add_phrase', ({ phrase }) => {
    const session = getSession(currentSessionId);
    if (!session || session.phase !== 'COLLECTING') return;
    const p = phrase?.trim();
    if (!p || session.phrases.includes(p)) return;
    session.phrases.push(p);
    io.to(session.id).emit('phrases_updated', { phrases: session.phrases });
  });

  socket.on('remove_phrase', ({ phraseIndex }) => {
    const session = getSession(currentSessionId);
    if (!session || session.phase !== 'COLLECTING') return;
    if (session.hostId !== socket.id) return;
    if (phraseIndex < 0 || phraseIndex >= session.phrases.length) return;
    session.phrases.splice(phraseIndex, 1);
    io.to(session.id).emit('phrases_updated', { phrases: session.phrases });
  });

  socket.on('start_collecting', () => {
    const session = getSession(currentSessionId);
    if (!session || session.hostId !== socket.id) return;
    if (session.phase !== 'LOBBY') return;
    session.phase = 'COLLECTING';
    io.to(session.id).emit('phase_changed', { phase: 'COLLECTING' });
  });

  socket.on('start_game', () => {
    const session = getSession(currentSessionId);
    if (!session || session.hostId !== socket.id) return;
    if (session.phase !== 'COLLECTING') return;
    if (session.phrases.length < 25) return;

    session.phase = 'PLAYING';

    // Generate a card per player
    const cards = {};
    for (const [id, player] of session.players) {
      player.card = generateCard(session.phrases);
      player.ticked = new Set();
      player.bingo = false;
      cards[id] = player.card;
    }
    session.winner = null;

    io.to(session.id).emit('phase_changed', { phase: 'PLAYING' });
    // Send each player their own card (and all others for spectator view)
    io.to(session.id).emit('game_started', { cards });
  });

  socket.on('tick_field', ({ index }) => {
    const session = getSession(currentSessionId);
    if (!session || session.phase !== 'PLAYING') return;
    const player = session.players.get(socket.id);
    if (!player) return;
    if (index < 0 || index > 24) return;

    const ticked = player.ticked.has(index);
    if (ticked) {
      player.ticked.delete(index);
    } else {
      player.ticked.add(index);
    }

    io.to(session.id).emit('field_ticked', {
      playerId: socket.id,
      index,
      ticked: !ticked,
    });

    if (!ticked && checkBingo(player.ticked) && !player.bingo) {
      player.bingo = true;
      session.winner = socket.id;
      session.phase = 'FINISHED';
      io.to(session.id).emit('bingo', {
        winnerId: socket.id,
        winnerName: player.name,
      });
    }
  });

  socket.on('restart_game', () => {
    const session = getSession(currentSessionId);
    if (!session || session.hostId !== socket.id) return;

    session.phase = 'COLLECTING';
    session.phrases = [];
    session.winner = null;
    for (const player of session.players.values()) {
      player.card = null;
      player.ticked = new Set();
      player.bingo = false;
    }

    io.to(session.id).emit('phase_changed', { phase: 'COLLECTING' });
    io.to(session.id).emit('phrases_updated', { phrases: [] });
  });

  socket.on('disconnect', () => {
    if (!currentSessionId) return;
    const session = sessions.get(currentSessionId);
    if (!session) return;

    session.players.delete(socket.id);
    io.to(session.id).emit('player_left', { playerId: socket.id });

    if (session.players.size === 0) {
      sessions.delete(session.id);
      return;
    }

    if (session.hostId === socket.id) {
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
}, 5 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`Bingo server running on http://localhost:${PORT}`);
});
