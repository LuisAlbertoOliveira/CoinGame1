'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../src/engine');

function setup(names = ['Ana', 'Bia', 'Caio']) {
  const clock = { t: 0 };
  const game = new Game({ code: 'PILE1', facilitatorId: 'FAC', now: () => clock.t });
  names.forEach((name, i) => game.join(`p${i + 1}`, name));
  game.start('FAC');
  return { game, clock };
}

// Número de moedas que existem em algum lugar do jogo: pilha, bancadas, filas e entregues.
function coinsInPlay(game) {
  const inStations = game.stations.reduce(
    (sum, s) => sum + (s.current ? s.current.coins.length : 0)
      + s.inbox.reduce((n, b) => n + b.coins.length, 0),
    0,
  );
  const delivered = game.delivered.reduce((n, b) => n + b.coins.length, 0);
  return game.pile.length + inStations + delivered;
}

// Moedas visíveis na bancada da primeira estação ativa (lote atual + restantes).
function headBenchCoins(game) {
  const head = game.stations[game.stations.findIndex((s) => !s.removed)];
  return (head.current ? head.current.coins.length : 0) + game.pile.length;
}

// Joga a rodada: vira o lote de cada estação e passa, checando a conservação das moedas.
function autoPlay(game, clock) {
  let guard = 0;
  while (game.status === 'running') {
    const st = game.stations.find((s) => !s.removed && s.current);
    assert.ok(st, 'travamento: nenhuma estação com lote na bancada');
    for (const coin of st.current.coins) {
      clock.t += 5;
      game.flip(st.playerId, st.current.id, coin.id);
    }
    clock.t += 5;
    game.pass(st.playerId);
    assert.equal(coinsInPlay(game), 20, 'moedas perdidas ou duplicadas');
    assert.ok(++guard < 10000, 'loop infinito');
  }
}

test('a bancada da primeira estação mostra 20 moedas no início de todas as rodadas', () => {
  const { game, clock } = setup();
  for (let round = 0; round < 4; round++) {
    if (round > 0) game.nextRound('FAC');
    assert.equal(headBenchCoins(game), 20, `rodada ${round + 1}`);
    assert.equal(game.snapshot().lot, [20, 10, 5, 2][round]);
    autoPlay(game, clock);
  }
});

test('rodada de 10: passar o primeiro grupo deixa 10 moedas na bancada', () => {
  const { game, clock } = setup();
  autoPlay(game, clock); // rodada de 20
  game.nextRound('FAC');

  const first = game.stations[0].current;
  assert.equal(first.coins.length, 10);
  assert.equal(game.pile.length, 10);

  clock.t += 10;
  for (const coin of first.coins) game.flip('p1', first.id, coin.id);
  game.pass('p1');

  assert.equal(game.stations[1].current.coins.length, 10);
  assert.equal(game.stations[0].current.id, 2);
  assert.equal(game.pile.length, 0);
  assert.equal(headBenchCoins(game), 10);
});

test('rodada de 2: a bancada vai diminuindo a cada grupo passado', () => {
  const { game, clock } = setup();
  for (let round = 0; round < 3; round++) {
    autoPlay(game, clock);
    game.nextRound('FAC');
  }
  assert.equal(game.snapshot().lot, 2);
  assert.equal(headBenchCoins(game), 20);

  const st = game.stations[0];
  clock.t += 5;
  for (const coin of st.current.coins) game.flip('p1', st.current.id, coin.id);
  game.pass('p1');
  assert.equal(headBenchCoins(game), 18);
});

test('a primeira estação sai no meio da rodada: as moedas restantes seguem para a próxima', () => {
  const { game, clock } = setup(['Ana', 'Bia', 'Caio', 'Dani']);
  autoPlay(game, clock); // rodada de 20
  game.nextRound('FAC');
  autoPlay(game, clock); // rodada de 10
  game.nextRound('FAC'); // rodada de 5

  // Ana passa o primeiro grupo de 5 e começa o segundo.
  let st = game.stations[0];
  for (const coin of st.current.coins) {
    clock.t += 5;
    game.flip('p1', st.current.id, coin.id);
  }
  game.pass('p1');
  assert.equal(game.pile.length, 10);

  // Ana cai e não volta no prazo.
  game.connectionLost('p1');
  game.dropPlayer('p1');

  assert.equal(game.stations[0].removed, true);
  assert.equal(game.snapshot().stations[1].head, true);
  assert.equal(game.pile.length, 10, 'as moedas da pilha não podem sumir');
  assert.equal(coinsInPlay(game), 20);
  assert.equal(game.status, 'running');

  // A próxima estação ativa assume a pilha e a rodada termina normalmente.
  autoPlay(game, clock);
  assert.equal(game.status, 'round_end');
  const last = game.results.at(-1);
  assert.equal(last.lote, 5);
  assert.equal(last.estacoes, 3);
});

test('a soma das moedas permanece 20 em todas as rodadas', () => {
  const { game, clock } = setup(['Ana', 'Bia', 'Caio', 'Dani', 'Eva']);
  for (let round = 0; round < 4; round++) {
    if (round > 0) game.nextRound('FAC');
    assert.equal(coinsInPlay(game), 20);
    autoPlay(game, clock);
  }
  assert.equal(game.results.length, 4);
});
