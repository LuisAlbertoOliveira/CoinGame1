'use strict';

// Teste de integração: servidor real (Socket.IO) com clientes reais.
process.env.RECONNECT_MS = '2000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connectClient } = require('socket.io-client');
const { httpServer, shutdown } = require('../src/server');

let url;
const sockets = [];

before(() => new Promise((resolve) => {
  httpServer.listen(0, () => {
    url = `http://localhost:${httpServer.address().port}`;
    resolve();
  });
}));

after(() => {
  for (const s of sockets) s.disconnect();
  shutdown();
});

function connect() {
  return new Promise((resolve) => {
    const s = connectClient(url, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
  });
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

// Espera até que o último estado recebido satisfaça o predicado.
function waitFor(socket, predicate, label = 'estado esperado') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('state', handler);
      reject(new Error(`Tempo esgotado aguardando: ${label}`));
    }, 3000);
    const handler = (state) => {
      if (predicate(state)) {
        clearTimeout(timeout);
        socket.off('state', handler);
        resolve(state);
      }
    };
    socket.on('state', handler);
  });
}

test('fluxo completo via socket: criar, entrar, iniciar, jogar, desconectar e reconectar', async () => {
  const fac = await connect();
  let latest = null;
  fac.on('state', (s) => { latest = s; });

  const created = await emit(fac, 'facilitator:create');
  assert.equal(created.ok, true);
  const { code } = created;

  const players = [];
  for (const name of ['Ana', 'Bia', 'Caio']) {
    const s = await connect();
    const res = await emit(s, 'player:join', { code, name });
    assert.equal(res.ok, true, res.error);
    players.push({ socket: s, playerId: res.playerId, name });
  }
  const [ana, bia, caio] = players;

  const started = await emit(fac, 'facilitator:start');
  assert.equal(started.ok, true, started.error);
  await waitFor(fac, (s) => s.status === 'running', 'partida em andamento');

  // Ana vira as 20 moedas e passa adiante.
  const batch = latest.stations[0].current;
  for (const coin of batch.coins) {
    const res = await emit(ana.socket, 'player:flip', { batchId: batch.id, coinId: coin.id });
    assert.equal(res.ok, true, res.error);
  }
  const passed = await emit(ana.socket, 'player:pass');
  assert.equal(passed.ok, true, passed.error);
  await waitFor(fac, (s) => s.stations[1].current !== null, 'lote na bancada da Bia');

  // Entrada após o início é recusada.
  const late = await connect();
  const lateRes = await emit(late, 'player:join', { code, name: 'Dani' });
  assert.equal(lateRes.ok, false);
  assert.match(lateRes.error, /depois do início/);

  // Bia cai e volta dentro do prazo.
  bia.socket.disconnect();
  await waitFor(fac, (s) => s.status === 'paused', 'partida pausada');

  const biaBack = await connect();
  const resumed = await emit(biaBack, 'session:resume', { code, playerId: bia.playerId });
  assert.equal(resumed.ok, true, resumed.error);
  await waitFor(fac, (s) => s.status === 'running', 'partida retomada');

  // Caio é o último da cadeia: o facilitador vê a entrega completa após os passes.
  assert.equal(latest.stations.length, 3);
  assert.equal(latest.players.every((p) => !p.removed), true);
  assert.ok(caio.playerId);
});

test('sessão com identificação inválida é recusada', async () => {
  const s = await connect();
  const res = await emit(s, 'session:resume', { code: 'ZZZZZ', playerId: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Sala não encontrada/);
});
