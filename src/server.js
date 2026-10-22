'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Game, GameError } = require('./engine');

const PORT = Number(process.env.PORT) || 3000;
const RECONNECT_MS = Number(process.env.RECONNECT_MS) || 30000;
const CLEANUP_MS = 10 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const rooms = new Map();

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const httpServer = http.createServer(app);
const io = new Server(httpServer);

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function findRoom(code) {
  const room = rooms.get(String(code || '').trim().toUpperCase());
  if (!room) throw new GameError('Sala não encontrada.');
  return room;
}

function createRoom() {
  const code = newCode();
  const game = new Game({ code, facilitatorId: crypto.randomUUID() });
  const room = {
    game,
    socketOf: new Map(),
    timeouts: new Map(),
    ticker: null,
    closed: false,
  };
  // Cronômetros são exibidos com atualização periódica enquanto a rodada corre.
  room.ticker = setInterval(() => {
    if (room.game.status === 'running') broadcast(room);
  }, 250);
  rooms.set(code, room);
  return room;
}

function closeRoom(room) {
  if (room.closed) return;
  room.closed = true;
  clearInterval(room.ticker);
  for (const t of room.timeouts.values()) clearTimeout(t);
  room.timeouts.clear();
  const cleanup = setTimeout(() => rooms.delete(room.game.code), CLEANUP_MS);
  cleanup.unref();
}

function broadcast(room) {
  io.to(room.game.code).emit('state', room.game.snapshot());
  if (room.game.status === 'ended') closeRoom(room);
}

function bind(socket, room, playerId) {
  socket.data.code = room.game.code;
  socket.data.playerId = playerId;
  socket.join(room.game.code);
  room.socketOf.set(playerId, socket.id);
  const pending = room.timeouts.get(playerId);
  if (pending) {
    clearTimeout(pending);
    room.timeouts.delete(playerId);
  }
}

function myRoom(socket) {
  const room = rooms.get(socket.data.code);
  if (!room || !socket.data.playerId) throw new GameError('Você não está em uma sala.');
  return room;
}

/** Envolve um evento: executa, responde com ack e transmite o estado da sala. */
function handler(socket, fn) {
  return (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const result = fn(payload || {}, socket) || {};
      const room = rooms.get(socket.data.code);
      if (room) broadcast(room);
      reply({ ok: true, ...result });
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      reply({
        ok: false,
        error: err instanceof GameError ? err.message : 'Erro interno do servidor.',
      });
    }
  };
}

io.on('connection', (socket) => {
  socket.on(
    'facilitator:create',
    handler(socket, () => {
      const room = createRoom();
      bind(socket, room, room.game.facilitatorId);
      return { code: room.game.code, playerId: room.game.facilitatorId };
    }),
  );

  socket.on(
    'player:join',
    handler(socket, ({ code, name }) => {
      const room = findRoom(code);
      const playerId = crypto.randomUUID();
      room.game.join(playerId, name);
      bind(socket, room, playerId);
      return { code: room.game.code, playerId };
    }),
  );

  socket.on(
    'session:resume',
    handler(socket, ({ code, playerId }) => {
      const room = findRoom(code);
      const isFacilitator = playerId === room.game.facilitatorId;
      const player = room.game.player(playerId);
      if (!isFacilitator && !player) {
        throw new GameError('Você não faz parte desta sala.');
      }
      room.game.connectionRestored(playerId);
      bind(socket, room, playerId);
      return { code: room.game.code, playerId, removed: Boolean(player?.removed) };
    }),
  );

  const facilitatorAction = (fn) =>
    handler(socket, (_payload, sock) => {
      const room = myRoom(sock);
      fn(room.game, sock.data.playerId);
      return {};
    });

  socket.on('facilitator:start', facilitatorAction((g, id) => g.start(id)));
  socket.on('facilitator:next', facilitatorAction((g, id) => g.nextRound(id)));
  socket.on('facilitator:restart', facilitatorAction((g, id) => g.restart(id)));
  socket.on('facilitator:end', facilitatorAction((g, id) => g.end(id)));

  socket.on(
    'player:flip',
    handler(socket, (payload, sock) => {
      const room = myRoom(sock);
      room.game.flip(sock.data.playerId, Number(payload.batchId), String(payload.coinId));
      return {};
    }),
  );

  socket.on(
    'player:pass',
    handler(socket, (_payload, sock) => {
      const room = myRoom(sock);
      room.game.pass(sock.data.playerId);
      return {};
    }),
  );

  socket.on(
    'player:leave',
    handler(socket, (_payload, sock) => {
      const room = myRoom(sock);
      room.game.leave(sock.data.playerId);
      sock.leave(room.game.code);
      sock.data.playerId = null;
      return {};
    }),
  );

  socket.on('disconnect', () => {
    const { code, playerId } = socket.data;
    const room = code && rooms.get(code);
    if (!room || !playerId) return;
    // Ignora desconexões de sockets já substituídos por uma reconexão.
    if (room.socketOf.get(playerId) !== socket.id) return;
    room.socketOf.delete(playerId);

    const { watch } = room.game.connectionLost(playerId);
    if (watch && !room.timeouts.has(playerId)) {
      const timer = setTimeout(() => {
        room.timeouts.delete(playerId);
        room.game.dropPlayer(playerId);
        broadcast(room);
      }, RECONNECT_MS);
      room.timeouts.set(playerId, timer);
    }
    broadcast(room);
  });
});

function shutdown() {
  for (const room of rooms.values()) closeRoom(room);
  io.close();
}

if (require.main === module) {
  httpServer.listen(PORT, () => {
    console.log(`Coin Game online em http://localhost:${PORT}`);
  });
}

module.exports = { httpServer, io, rooms, shutdown };
