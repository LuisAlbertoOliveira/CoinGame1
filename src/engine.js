'use strict';

// Regras de negócio do Coin Game. Não depende de socket nem de relógio real:
// o tempo é injetado via `now`, o que permite testar a partida inteira.

const LOTS = [20, 10, 5, 2];
const TOTAL_COINS = 20;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 5;
const MAX_NAME_LENGTH = 20;

class GameError extends Error {}

function fail(message) {
  throw new GameError(message);
}

function normalizeName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 1) fail('Informe um nome ou apelido.');
  if (name.length > MAX_NAME_LENGTH) {
    fail(`O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`);
  }
  return name;
}

function batchView(batch) {
  return {
    id: batch.id,
    hops: batch.hops,
    coins: batch.coins.map((c) => ({
      id: c.id,
      color: c.color,
      flippedHere: c.flippedHere,
    })),
  };
}

/**
 * Estados: lobby | running | paused | round_end | ended
 *
 * - lobby: pré-sala, jogadores entram e o facilitador inicia.
 * - running: rodada em andamento, cronômetros contando.
 * - paused: algum jogador (ou o facilitador) desconectou; cronômetros congelados.
 * - round_end: todas as moedas chegaram ao cliente.
 * - ended: partida encerrada (facilitador, queda abaixo de 3 jogadores, etc.).
 */
class Game {
  constructor({ code, facilitatorId, now = () => Date.now() }) {
    this.code = code;
    this.facilitatorId = facilitatorId;
    this.now = now;
    this.createdAt = now();
    this.status = 'lobby';
    this.players = [];
    this.stations = [];
    this.roundIndex = 0;
    this.results = [];
    this.endReason = null;
    this.facilitatorConnected = true;
    this.pausedBy = new Set();
    this._resetRound();
  }

  // ---------- consultas ----------

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  stationOf(id) {
    return this.stations.find((s) => s.playerId === id);
  }

  activeStations() {
    return this.stations.filter((s) => !s.removed);
  }

  nameOf(id) {
    if (id === this.facilitatorId) return 'Facilitador';
    return this.player(id)?.name ?? '—';
  }

  // ---------- pré-sala ----------

  join(id, rawName) {
    if (this.status !== 'lobby') {
      fail('Não é possível entrar depois do início da partida.');
    }
    if (id === this.facilitatorId) fail('O facilitador não entra como jogador.');
    if (this.players.length >= MAX_PLAYERS) {
      fail(`Sala cheia (máximo de ${MAX_PLAYERS} jogadores).`);
    }
    const name = normalizeName(rawName);
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      fail('Este nome já está na sala.');
    }
    this.players.push({ id, name, connected: true, removed: false });
  }

  leave(id) {
    if (this.status !== 'lobby') fail('Só é possível sair antes do início.');
    this.players = this.players.filter((p) => p.id !== id);
  }

  _assertFacilitator(id) {
    if (id !== this.facilitatorId) fail('Apenas o facilitador pode fazer isso.');
  }

  start(facilitatorId) {
    this._assertFacilitator(facilitatorId);
    if (this.status !== 'lobby') fail('A partida já começou.');
    if (this.players.length < MIN_PLAYERS) {
      fail(`São necessários pelo menos ${MIN_PLAYERS} jogadores para iniciar.`);
    }
    // Estações são criadas a partir dos jogadores presentes no início.
    this.stations = this.players.map((p) => ({
      playerId: p.id,
      removed: false,
      inbox: [],
      current: null,
    }));
    this.roundIndex = 0;
    this.results = [];
    this._beginRound();
  }

  // ---------- rodadas ----------

  _resetRound() {
    this.pile = [];        // moedas ainda na bancada da primeira estação
    this.batchSeq = 0;
    this.lot = LOTS[this.roundIndex];
    this.delivered = [];
    this.timer = { started: false, acc: 0, runSince: null, firstMs: null, totalMs: null };
    for (const s of this.stations) {
      s.inbox = [];
      s.current = null;
    }
  }

  _beginRound() {
    this._resetRound();
    // A bancada da primeira estação sempre começa com as 20 moedas,
    // em qualquer rodada. O tamanho do lote define quanto pode ser passado.
    this.pile = Array.from({ length: TOTAL_COINS }, (_, c) => ({
      id: `c${c + 1}`,
      color: 'black',
      flippedHere: false,
    }));
    const first = this._nextActive(0);
    if (first < 0) fail('Não há estações ativas.');
    this.status = this.pausedBy.size ? 'paused' : 'running';
    this._pull(first);
  }

  nextRound(facilitatorId) {
    this._assertFacilitator(facilitatorId);
    if (this.status !== 'round_end') fail('A rodada ainda não terminou.');
    if (this.roundIndex >= LOTS.length - 1) fail('Não há próxima rodada.');
    this.roundIndex += 1;
    this._beginRound();
  }

  _nextActive(from) {
    for (let i = from; i < this.stations.length; i++) {
      if (!this.stations[i].removed) return i;
    }
    return -1;
  }

  // Coloca o próximo lote na bancada, se ela estiver livre.
  // A primeira estação ativa recorta o próximo grupo da pilha de 20 moedas.
  _pull(idx) {
    if (idx < 0) return;
    const st = this.stations[idx];
    if (st.removed || st.current) return;
    if (st.inbox.length) {
      st.current = st.inbox.shift();
    } else if (idx === this._nextActive(0) && this.pile.length) {
      st.current = this._cutBatch();
    } else {
      return;
    }
    for (const c of st.current.coins) c.flippedHere = false;
  }

  _cutBatch() {
    this.batchSeq += 1;
    return {
      id: this.batchSeq,
      hops: 0,
      coins: this.pile.splice(0, this.lot),
    };
  }

  _arrive(idx, batch) {
    if (idx < 0) {
      this._deliver(batch);
      return;
    }
    this.stations[idx].inbox.push(batch);
    this._pull(idx);
  }

  _deliver(batch) {
    this.delivered.push(batch);
    if (this.timer.firstMs === null) this.timer.firstMs = this._elapsed();
    if (this.delivered.length === TOTAL_COINS / this.lot) this._finishRound();
  }

  _finishRound() {
    this._freeze();
    this.timer.totalMs = this.timer.acc;
    this.results.push({
      rodada: this.roundIndex + 1,
      lote: LOTS[this.roundIndex],
      estacoes: this.activeStations().length,
      tempoTotalMs: this.timer.totalMs,
      primeiraEntregaMs: this.timer.firstMs,
      concluidaEm: this.now(),
    });
    this.status = 'round_end';
  }

  // ---------- cronômetros ----------

  _elapsed() {
    const t = this.timer;
    return t.acc + (t.runSince !== null ? this.now() - t.runSince : 0);
  }

  _freeze() {
    const t = this.timer;
    if (t.runSince !== null) {
      t.acc += this.now() - t.runSince;
      t.runSince = null;
    }
  }

  _thaw() {
    const t = this.timer;
    if (t.started && t.totalMs === null && t.runSince === null) {
      t.runSince = this.now();
    }
  }

  // ---------- ações dos jogadores ----------

  _assertRunning() {
    if (this.status !== 'running') fail('A partida não está em andamento.');
  }

  flip(playerId, batchId, coinId) {
    this._assertRunning();
    const st = this.stationOf(playerId);
    if (!st || st.removed) fail('Você não tem uma estação ativa.');
    if (!st.current || st.current.id !== batchId) {
      fail('Este lote não está na sua bancada.');
    }
    const coin = st.current.coins.find((c) => c.id === coinId);
    if (!coin) fail('Moeda não encontrada.');
    if (coin.flippedHere) fail('Esta moeda já foi virada nesta estação.');

    coin.color = coin.color === 'black' ? 'white' : 'black';
    coin.flippedHere = true;

    // Primeiro clique da rodada inicia os cronômetros.
    if (!this.timer.started) {
      this.timer.started = true;
      this.timer.runSince = this.now();
    }
  }

  pass(playerId) {
    this._assertRunning();
    const idx = this.stations.findIndex((s) => s.playerId === playerId);
    if (idx < 0 || this.stations[idx].removed) fail('Você não tem uma estação ativa.');
    const st = this.stations[idx];
    if (!st.current) fail('Não há lote na sua bancada.');
    if (!st.current.coins.every((c) => c.flippedHere)) {
      fail('Vire todas as moedas do lote antes de passar adiante.');
    }
    const batch = st.current;
    st.current = null;
    batch.hops += 1;
    this._arrive(this._nextActive(idx + 1), batch);
    this._pull(idx);
  }

  // ---------- conexão ----------

  _pauseFor(id) {
    this.pausedBy.add(id);
    if (this.status === 'running') {
      this._freeze();
      this.status = 'paused';
    }
  }

  _maybeResume() {
    if (this.status === 'paused' && this.pausedBy.size === 0) {
      this.status = 'running';
      this._thaw();
    }
  }

  /** Retorna { watch }: se true, o servidor deve aguardar a reconexão. */
  connectionLost(id) {
    if (this.status === 'ended') return { watch: false };

    if (id === this.facilitatorId) {
      this.facilitatorConnected = false;
      if (this.status !== 'lobby') this._pauseFor(id);
      return { watch: true };
    }

    const p = this.player(id);
    if (!p || p.removed) return { watch: false };
    p.connected = false;

    if (this.status === 'lobby') {
      this.players = this.players.filter((x) => x.id !== id);
      return { watch: false };
    }
    this._pauseFor(id);
    return { watch: true };
  }

  connectionRestored(id) {
    if (this.status === 'ended') return;
    if (id === this.facilitatorId) {
      this.facilitatorConnected = true;
    } else {
      const p = this.player(id);
      if (p && !p.removed) p.connected = true;
    }
    this.pausedBy.delete(id);
    this._maybeResume();
  }

  /** Chamado quando o tempo de reconexão (30 s) expira sem retorno. */
  dropPlayer(id) {
    if (this.status === 'ended') return;
    if (id === this.facilitatorId) {
      this.endGame('O facilitador não voltou dentro do prazo de reconexão.');
      return;
    }
    const p = this.player(id);
    if (!p || p.removed || p.connected) return;
    p.removed = true;
    this.pausedBy.delete(id);

    const idx = this.stations.findIndex((s) => s.playerId === id);
    if (idx >= 0) {
      const st = this.stations[idx];
      st.removed = true;
      const carried = [...(st.current ? [st.current] : []), ...st.inbox];
      st.current = null;
      st.inbox = [];
      // Os lotes seguem para a próxima estação ativa; se não houver, vão ao cliente.
      const next = this._nextActive(idx + 1);
      if (next >= 0) {
        this.stations[next].inbox.unshift(...carried);
        this._pull(next);
      } else {
        for (const batch of carried) this._deliver(batch);
      }
    }

    if (this.activeStations().length < MIN_PLAYERS) {
      this.endGame(`Menos de ${MIN_PLAYERS} jogadores na partida.`);
      return;
    }
    this._maybeResume();
  }

  // ---------- controle do facilitador ----------

  restart(facilitatorId) {
    this._assertFacilitator(facilitatorId);
    if (this.status === 'ended') fail('A sala já foi encerrada.');
    // Reinício mantém apenas quem está conectado; contadores e tabela são zerados.
    this.players = this.players.filter((p) => !p.removed && p.connected);
    this.stations = [];
    this.results = [];
    this.roundIndex = 0;
    this.pausedBy.clear();
    this._resetRound();
    this.status = 'lobby';
    this.endReason = null;
  }

  end(facilitatorId) {
    this._assertFacilitator(facilitatorId);
    if (this.status === 'ended') fail('A sala já foi encerrada.');
    this.endGame('Partida encerrada pelo facilitador.');
  }

  endGame(reason) {
    this._freeze();
    this.status = 'ended';
    this.endReason = reason;
    this.pausedBy.clear();
  }

  // ---------- visão para os clientes ----------

  snapshot() {
    return {
      code: this.code,
      status: this.status,
      endReason: this.endReason,
      createdAt: this.createdAt,
      facilitatorId: this.facilitatorId,
      facilitatorConnected: this.facilitatorConnected,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      roundIndex: this.roundIndex,
      lot: LOTS[this.roundIndex],
      lots: LOTS,
      batchesTotal: TOTAL_COINS / LOTS[this.roundIndex],
      pausedBy: [...this.pausedBy].map((id) => this.nameOf(id)),
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        removed: p.removed,
      })),
      pileCount: this.pile.length,
      stations: this.stations.map((s, i) => ({
        playerId: s.playerId,
        name: this.nameOf(s.playerId),
        removed: s.removed,
        head: i === this._nextActive(0),
        queue: s.inbox.length,
        current: s.current ? batchView(s.current) : null,
      })),
      delivered: this.delivered.map(batchView),
      timer: {
        started: this.timer.started,
        totalMs: this._elapsed(),
        firstMs: this.timer.firstMs,
      },
      results: this.results,
    };
  }
}

module.exports = {
  Game,
  GameError,
  LOTS,
  TOTAL_COINS,
  MIN_PLAYERS,
  MAX_PLAYERS,
};
