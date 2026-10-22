'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError } = require('../src/engine');

function setup(names = ['Ana', 'Bia', 'Caio']) {
  const clock = { t: 0 };
  const game = new Game({ code: 'TEST1', facilitatorId: 'FAC', now: () => clock.t });
  names.forEach((name, i) => game.join(`p${i + 1}`, name));
  return { game, clock };
}

// Vira todas as moedas do lote atual da estação e passa adiante, no instante t.
function turn(game, clock, playerId, t) {
  clock.t = t;
  const st = game.stationOf(playerId);
  for (const coin of st.current.coins) game.flip(playerId, st.current.id, coin.id);
  game.pass(playerId);
}

// Joga a rodada inteira automaticamente, avançando o relógio a cada ação.
function autoPlay(game, clock) {
  let guard = 0;
  while (game.status === 'running') {
    const st = game.stations.find((s) => !s.removed && s.current);
    assert.ok(st, 'travamento: nenhuma estação com lote na bancada');
    for (const coin of st.current.coins) {
      clock.t += 10;
      game.flip(st.playerId, st.current.id, coin.id);
    }
    clock.t += 10;
    game.pass(st.playerId);
    assert.ok(++guard < 10000, 'loop infinito');
  }
}

test('partida com 3 jogadores cria 3 estações e começa com lote de 20', () => {
  const { game } = setup();
  game.start('FAC');
  assert.equal(game.status, 'running');
  assert.equal(game.stations.length, 3);
  assert.equal(game.stations[0].current.coins.length, 20);
  assert.equal(game.stations[1].current, null);
  assert.equal(game.snapshot().lot, 20);
});

test('não inicia com menos de 3 jogadores e não aceita entrada após o início', () => {
  const { game } = setup(['Ana', 'Bia']);
  assert.throws(() => game.start('FAC'), /pelo menos 3/);
  game.join('p3', 'Caio');
  game.start('FAC');
  assert.throws(() => game.join('p4', 'Dani'), /depois do início/);
});

test('sala aceita no máximo 5 jogadores', () => {
  const { game } = setup(['A', 'B', 'C', 'D', 'E']);
  assert.throws(() => game.join('p6', 'F'), /Sala cheia/);
});

test('apenas o facilitador inicia e reinicia; nomes duplicados e vazios são recusados', () => {
  const { game } = setup();
  assert.throws(() => game.start('p1'), GameError);
  game.start('FAC');
  assert.throws(() => game.restart('p1'), GameError);

  const other = setup();
  assert.throws(() => other.game.join('p9', 'ana'), /já está na sala/);
  assert.throws(() => other.game.join('p9', '   '), /Informe um nome/);
});

test('não é possível passar lote incompleto', () => {
  const { game } = setup();
  game.start('FAC');
  game.flip('p1', 1, 'c1');
  assert.throws(() => game.pass('p1'), /Vire todas as moedas/);
});

test('estação não pode virar lote que não está na sua bancada', () => {
  const { game } = setup();
  game.start('FAC');
  assert.throws(() => game.flip('p2', 1, 'c1'), /não está na sua bancada/);
});

test('rodada de 20 registra tempo total e primeira entrega', () => {
  const { game, clock } = setup();
  game.start('FAC');
  turn(game, clock, 'p1', 1000); // primeiro clique inicia os cronômetros em 1000
  turn(game, clock, 'p2', 3000);
  turn(game, clock, 'p3', 6000); // último lote chega ao cliente em 6000

  assert.equal(game.status, 'round_end');
  assert.deepEqual(game.results, [
    {
      rodada: 1,
      lote: 20,
      estacoes: 3,
      tempoTotalMs: 5000,
      primeiraEntregaMs: 5000,
      concluidaEm: 6000,
    },
  ]);
});

test('sequência 20 → 10 → 5 → 2 gera uma linha por rodada', () => {
  const { game, clock } = setup();
  game.start('FAC');
  const expectedBatches = [1, 2, 4, 10];
  for (let round = 0; round < 4; round++) {
    if (round > 0) game.nextRound('FAC');
    assert.equal(game.snapshot().batchesTotal, expectedBatches[round]);
    autoPlay(game, clock);
  }
  assert.equal(game.status, 'round_end');
  assert.deepEqual(game.results.map((r) => r.lote), [20, 10, 5, 2]);
  assert.throws(() => game.nextRound('FAC'), /Não há próxima rodada/);
});

test('com lote de 2 a estação segue para o próximo sublote sem esperar a cadeia inteira', () => {
  const { game, clock } = setup();
  game.start('FAC');
  autoPlay(game, clock); // rodada de 20
  for (let i = 0; i < 2; i++) {
    game.nextRound('FAC'); // rodadas de 10 e de 5
    autoPlay(game, clock);
  }
  game.nextRound('FAC'); // rodada de lote 2
  assert.equal(game.stations[0].current.id, 1);

  turn(game, clock, 'p1', 100);
  // Ana passou o lote 1 e já está com o lote 2, mesmo sem Bia ter terminado nada.
  assert.equal(game.stations[0].current.id, 2);
  assert.equal(game.stations[1].current.id, 1);
});

test('desconexão pausa, congela cronômetros e retoma ao reconectar', () => {
  const { game, clock } = setup();
  game.start('FAC');
  clock.t = 0;
  game.flip('p1', 1, 'c1'); // inicia em 0

  clock.t = 2000;
  const { watch } = game.connectionLost('p2');
  assert.equal(watch, true);
  assert.equal(game.status, 'paused');

  clock.t = 5000;
  assert.equal(game.snapshot().timer.totalMs, 2000);
  assert.throws(() => game.flip('p1', 1, 'c2'), /não está em andamento/);

  game.connectionRestored('p2');
  assert.equal(game.status, 'running');
  clock.t = 6000;
  assert.equal(game.snapshot().timer.totalMs, 3000);
});

test('reconexão dentro do prazo mantém o jogador na partida', () => {
  const { game } = setup(['Ana', 'Bia', 'Caio', 'Dani']);
  game.start('FAC');
  game.connectionLost('p2');
  game.connectionRestored('p2');
  game.dropPlayer('p2'); // timer antigo disparando após reconexão: nada deve acontecer
  assert.equal(game.player('p2').removed, false);
  assert.equal(game.status, 'running');
});

test('estação removida faz o lote seguir para a próxima estação ativa', () => {
  const { game, clock } = setup(['Ana', 'Bia', 'Caio', 'Dani']);
  game.start('FAC');
  turn(game, clock, 'p1', 1000); // Bia recebe o lote 1

  game.connectionLost('p2');
  game.dropPlayer('p2');

  assert.equal(game.stations[1].removed, true);
  assert.equal(game.stations[2].current.id, 1);
  assert.equal(game.status, 'running');
  assert.equal(game.activeStations().length, 3);
});

test('se a última estação sai, o lote vai direto ao cliente', () => {
  const { game, clock } = setup(['Ana', 'Bia', 'Caio', 'Dani']);
  game.start('FAC');
  turn(game, clock, 'p1', 1000);
  turn(game, clock, 'p2', 2000);
  turn(game, clock, 'p3', 3000); // lote 1 está com Dani

  game.connectionLost('p4');
  game.dropPlayer('p4');

  assert.equal(game.status, 'round_end');
  assert.equal(game.delivered.length, 1);
  assert.equal(game.results[0].estacoes, 3);
});

test('queda abaixo de 3 jogadores encerra a partida', () => {
  const { game } = setup();
  game.start('FAC');
  game.connectionLost('p2');
  game.dropPlayer('p2');
  assert.equal(game.status, 'ended');
  assert.match(game.endReason, /Menos de 3/);
});

test('queda do facilitador pausa e, após o prazo, encerra a sala', () => {
  const { game } = setup();
  game.start('FAC');
  game.connectionLost('FAC');
  assert.equal(game.status, 'paused');
  game.dropPlayer('FAC');
  assert.equal(game.status, 'ended');
});

test('reinício zera contadores e tabela e mantém só jogadores conectados', () => {
  const { game, clock } = setup(['Ana', 'Bia', 'Caio', 'Dani']);
  game.start('FAC');
  autoPlay(game, clock);
  assert.equal(game.results.length, 1);

  game.restart('FAC');
  assert.equal(game.status, 'lobby');
  assert.equal(game.results.length, 0);
  assert.equal(game.players.length, 4);
});

test('reinício após saída de jogador mantém apenas os que estão na sala', () => {
  const { game } = setup(['Ana', 'Bia', 'Caio', 'Dani']);
  game.start('FAC');
  game.connectionLost('p2');
  game.dropPlayer('p2');
  game.restart('FAC');
  assert.deepEqual(game.players.map((p) => p.name), ['Ana', 'Caio', 'Dani']);
});

test('facilitador pode encerrar a partida a qualquer momento', () => {
  const { game } = setup();
  game.start('FAC');
  game.end('FAC');
  assert.equal(game.status, 'ended');
  assert.equal(game.endReason, 'Partida encerrada pelo facilitador.');
});

test('passar e virar são bloqueados fora da rodada em andamento', () => {
  const { game, clock } = setup();
  game.start('FAC');
  autoPlay(game, clock);
  assert.throws(() => game.flip('p1', 1, 'c1'), /não está em andamento/);
  assert.throws(() => game.pass('p1'), /não está em andamento/);
});
