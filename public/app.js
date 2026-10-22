/* global io */
'use strict';

const socket = io();
const SESSION_KEY = 'coin-game-session';
const app = document.getElementById('app');
const roomInfo = document.getElementById('roomInfo');
const lotBar = document.getElementById('lotBar');
const toastEl = document.getElementById('toast');

let session = loadSession(); // { code, playerId }
let state = null;
let lastSignature = null;

// ---------- utilitários ----------

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(s) {
  session = s;
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

function clearSession() {
  session = null;
  state = null;
  localStorage.removeItem(SESSION_KEY);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function pad(n, size = 2) {
  return String(n).padStart(size, '0');
}

function fmt(ms) {
  if (ms === null || ms === undefined) return '--:--.--';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

function request(event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => resolve(res || { ok: false, error: 'Sem resposta do servidor.' }));
  });
}

async function act(event, payload) {
  const res = await request(event, payload);
  if (!res.ok) toast(res.error);
  return res;
}

function myRole() {
  if (!session || !state) return null;
  if (session.playerId === state.facilitatorId) return 'facilitator';
  const me = state.players.find((p) => p.id === session.playerId);
  if (!me) return 'out';
  return me.removed ? 'spectator' : 'player';
}

function signature(s) {
  const { timer, ...rest } = s; // eslint-disable-line no-unused-vars
  return JSON.stringify(rest);
}

// ---------- conexão ----------

socket.on('connect', async () => {
  if (session) {
    const res = await request('session:resume', { code: session.code, playerId: session.playerId });
    if (!res.ok) {
      toast(res.error);
      clearSession();
    }
  }
  render();
});

socket.on('disconnect', () => toast('Conexão perdida. Tentando reconectar...'));

socket.on('state', (s) => {
  state = s;
  const sig = signature(s);
  // Atualiza só os cronômetros quando nada estrutural mudou (evita perder cliques).
  if (sig === lastSignature && document.getElementById('tTotal')) {
    updateTimers();
    return;
  }
  lastSignature = sig;
  render();
});

// ---------- renderização ----------

function render() {
  if (!session || !state) {
    roomInfo.textContent = '';
    lotBar.innerHTML = '';
    renderHome();
    return;
  }
  roomInfo.textContent = `Sala ${state.code}`;
  renderLotBar();
  if (state.status === 'lobby') {
    renderLobby();
  } else {
    renderGame();
  }
}

function renderLotBar() {
  lotBar.innerHTML = state.lots
    .map((lot, i) => `<span class="lot-chip ${i === state.roundIndex ? '' : 'dim'}">${lot}</span>`)
    .join('');
}

function renderHome() {
  app.innerHTML = `
    <section class="card narrow">
      <h2>Entrar em uma sala</h2>
      <form id="joinForm" class="stack">
        <input name="name" placeholder="Seu nome ou apelido" maxlength="20" required>
        <input name="code" placeholder="Código da sala" maxlength="5" required style="text-transform:uppercase">
        <button type="submit" class="btn primary">Entrar</button>
      </form>
    </section>
    <section class="card narrow">
      <h2>Sou o facilitador</h2>
      <p class="muted">Crie uma sala e compartilhe o código com os jogadores (de 3 a 5).</p>
      <button class="btn primary" data-action="create">Criar sala</button>
    </section>`;
}

function renderLobby() {
  const role = myRole();
  const n = state.players.length;
  const ready = n >= state.minPlayers && n <= state.maxPlayers;
  const list = state.players
    .map((p) => `<li>${escapeHtml(p.name)}${p.id === session.playerId ? ' (você)' : ''}</li>`)
    .join('') || '<li class="muted">Ninguém entrou ainda.</li>';

  const facilitatorPart = role === 'facilitator'
    ? `<div class="panel">
         <button class="btn primary" data-action="start" ${ready ? '' : 'disabled'}>Iniciar jogo</button>
         <button class="btn danger" data-action="end">Encerrar sala</button>
       </div>
       <p class="muted">${ready
         ? `Pronto para iniciar com ${n} jogador(es).`
         : `São necessários de ${state.minPlayers} a ${state.maxPlayers} jogadores (${n} na sala).`}</p>`
    : `<p class="muted">Aguardando o facilitador iniciar o jogo.</p>
       <div class="panel"><button class="btn" data-action="leave">Sair da sala</button></div>`;

  app.innerHTML = `
    <section class="card narrow">
      <h2>Pré-sala</h2>
      <p>Código da sala: <strong class="room-code">${escapeHtml(state.code)}</strong></p>
      <h3>Jogadores (${n}/${state.maxPlayers})</h3>
      <ul class="players">${list}</ul>
      ${facilitatorPart}
    </section>`;
}

function renderGame() {
  const role = myRole();
  const myStation = state.stations.find((s) => s.playerId === session.playerId && !s.removed);
  const canAct = state.status === 'running' && Boolean(myStation);

  const stationsHtml = state.stations
    .map((s) => stationCard(s, s.playerId === session.playerId, canAct, state.pileCount))
    .join('');

  const clientHtml = `
    <div class="client">
      <h4>Entrega para o cliente</h4>
      <p class="muted">Entregues: ${state.delivered.length} de ${state.batchesTotal} lote(s)</p>
      ${state.delivered.length === 0 ? '<p class="muted">Nenhuma moeda entregue ainda.</p>' : ''}
      ${state.delivered.map((b) => `
        <div class="delivered">
          <span class="muted">Lote ${b.id}</span>
          <div class="coins">${b.coins.map((c) => `<span class="coin static ${c.color}"></span>`).join('')}</div>
        </div>`).join('')}
    </div>`;

  app.innerHTML = `
    ${bannerHtml()}
    <section class="timers">
      <div class="timer"><span>Tempo total</span><strong id="tTotal">${fmt(totalMs())}</strong></div>
      <div class="timer"><span>Primeira entrega ao cliente</span><strong id="tFirst">${fmt(firstMs())}</strong></div>
    </section>
    <section class="line">${stationsHtml}${clientHtml}</section>
    ${role === 'facilitator' ? facilitatorPanel() : ''}
    ${role === 'spectator' ? '<p class="muted">Você saiu da partida e acompanha como espectador.</p>' : ''}
    ${state.status === 'ended' ? '<div class="panel"><button class="btn" data-action="leave">Voltar ao início</button></div>' : ''}
    ${resultsTable()}`;
}

function totalMs() {
  return state.timer.totalMs;
}

function firstMs() {
  if (state.timer.firstMs !== null) return state.timer.firstMs;
  return state.timer.started ? state.timer.totalMs : null;
}

function updateTimers() {
  const t = document.getElementById('tTotal');
  const f = document.getElementById('tFirst');
  if (t) t.textContent = fmt(totalMs());
  if (f) f.textContent = fmt(firstMs());
}

function bannerHtml() {
  const lot = state.lot;
  const last = state.roundIndex === state.lots.length - 1;
  let cls = state.status;
  let text;
  switch (state.status) {
    case 'running':
      text = `Rodada ${state.roundIndex + 1}: vire e passe adiante grupos de ${lot} moeda(s).`;
      break;
    case 'paused':
      text = `Partida pausada: aguardando reconexão de ${state.pausedBy.map(escapeHtml).join(', ')} (até 30 s).`;
      break;
    case 'round_end':
      text = `Rodada ${state.roundIndex + 1} concluída (lote de ${lot}). ${
        last ? 'Escolha uma opção abaixo.' : 'Aguardando o facilitador para a próxima rodada.'}`;
      if (state.pausedBy.length) text += ` Aguardando reconexão de ${state.pausedBy.map(escapeHtml).join(', ')}.`;
      break;
    case 'ended':
      text = `Partida encerrada. ${escapeHtml(state.endReason || '')}`;
      break;
    default:
      text = '';
      cls = '';
  }
  return `<div class="banner ${cls}">${text}</div>`;
}

function stationCard(s, mine, canAct, pileCount) {
  const classes = ['station', mine ? 'mine' : '', s.removed ? 'removed' : ''].join(' ');
  // Moedas da bancada da primeira estação que ainda não foram recortadas em lotes.
  const pileHtml = s.head && pileCount > 0
    ? `<p class="muted small">Restantes na bancada (${pileCount}):</p>
       <div class="coins">${'<span class="coin black pile" aria-hidden="true"></span>'.repeat(pileCount)}</div>`
    : '';
  let body;
  if (s.removed) {
    body = '<p class="muted">Saiu da partida. Estação saltada.</p>';
  } else if (!s.current) {
    body = `${pileHtml}<p class="muted">Fila: ${s.queue}</p>`;
  } else {
    const batch = s.current;
    const allFlipped = batch.coins.every((c) => c.flippedHere);
    const coins = batch.coins
      .map((c) => {
        const active = mine && canAct && !c.flippedHere;
        return `<button class="coin ${c.color} ${c.flippedHere ? 'done' : ''} ${active ? 'active' : ''}"
                  data-action="flip" data-batch="${batch.id}" data-coin="${c.id}"
                  ${active ? '' : 'disabled'} aria-label="Moeda ${c.color}"></button>`;
      })
      .join('');
    const passBtn = mine
      ? `<button class="btn pass" data-action="pass" ${allFlipped && canAct ? '' : 'disabled'}>Passar adiante</button>`
      : '';
    body = `<p class="muted small">Lote atual (${batch.coins.length}):</p>
            <div class="coins">${coins}</div>
            ${pileHtml}
            <p class="muted">Lote ${batch.id} · fila: ${s.queue}</p>
            ${passBtn}`;
  }
  return `<div class="${classes}"><h4>${escapeHtml(s.name)}${mine ? ' (você)' : ''}</h4>${body}</div>`;
}

function facilitatorPanel() {
  const status = state.status;
  const restartBtn = '<button class="btn danger" data-action="restart">Parar e reiniciar</button>';
  const endBtn = '<button class="btn danger" data-action="end">Encerrar jogo</button>';

  if (status === 'running' || status === 'paused') {
    return `<div class="panel">${restartBtn} ${endBtn}</div>`;
  }
  if (status === 'round_end') {
    if (state.roundIndex < state.lots.length - 1) {
      const nextLot = state.lots[state.roundIndex + 1];
      return `<div class="panel">
        <button class="btn primary" data-action="next">Próxima rodada (lote de ${nextLot})</button>
        ${restartBtn} ${endBtn}</div>`;
    }
    return `<div class="panel">
      <button class="btn primary" data-action="report">Baixar relatório</button>
      <button class="btn" data-action="restart">Reiniciar partida</button>
      ${endBtn}</div>`;
  }
  if (status === 'ended' && state.results.length) {
    return '<div class="panel"><button class="btn primary" data-action="report">Baixar relatório</button></div>';
  }
  return '';
}

function resultsTable() {
  if (!state.results.length) return '';
  const rows = state.results
    .map((r) => `<tr>
        <td>${r.rodada}</td><td>${r.lote}</td><td>${r.estacoes}</td>
        <td>${fmt(r.tempoTotalMs)}</td><td>${fmt(r.primeiraEntregaMs)}</td>
      </tr>`)
    .join('');
  return `
    <section class="card">
      <h3>Resultados da sala</h3>
      <table>
        <thead><tr><th>Rodada</th><th>Lote</th><th>Estações</th><th>Tempo total</th><th>Primeira entrega</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

// ---------- relatório ----------

function csvCell(value) {
  const s = String(value ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadReport() {
  if (!state.results.length) {
    toast('Ainda não há resultados para o relatório.');
    return;
  }
  const now = new Date();
  const dateTime = (value) => new Date(value).toLocaleString('pt-BR');
  const seconds = (ms) => (ms / 1000).toFixed(2).replace('.', ',');
  const participants = state.players
    .map((p) => (p.removed ? `${p.name} (saiu)` : p.name))
    .join(', ');

  const lines = [
    ['Sala', state.code],
    ['Início da sala', dateTime(state.createdAt)],
    ['Download do relatório', dateTime(now)],
    ['Participantes', participants],
    [],
    ['Rodada', 'Lote', 'Estações ativas', 'Tempo total (s)', 'Primeira entrega (s)', 'Concluída em'],
    ...state.results.map((r) => [
      r.rodada,
      r.lote,
      r.estacoes,
      seconds(r.tempoTotalMs),
      seconds(r.primeiraEntregaMs),
      dateTime(r.concluidaEm),
    ]),
  ];

  const csv = '﻿' + lines.map((row) => row.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `coin-game-${state.code}-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- eventos ----------

app.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'create': {
      const res = await act('facilitator:create');
      if (res.ok) {
        saveSession({ code: res.code, playerId: res.playerId });
        render();
      }
      break;
    }
    case 'start':
      await act('facilitator:start');
      break;
    case 'next':
      await act('facilitator:next');
      break;
    case 'restart':
      if (confirm('Parar e reiniciar a partida? Contadores e tabela serão zerados e nada será salvo.')) {
        await act('facilitator:restart');
      }
      break;
    case 'end':
      if (confirm('Encerrar o jogo?')) await act('facilitator:end');
      break;
    case 'report':
      downloadReport();
      break;
    case 'flip':
      await act('player:flip', { batchId: Number(el.dataset.batch), coinId: el.dataset.coin });
      break;
    case 'pass':
      await act('player:pass');
      break;
    case 'leave': {
      if (role() === 'player' && state && state.status === 'lobby') {
        await act('player:leave');
      }
      clearSession();
      render();
      break;
    }
    default:
      break;
  }
});

function role() {
  return myRole();
}

app.addEventListener('submit', async (event) => {
  if (event.target.id !== 'joinForm') return;
  event.preventDefault();
  const data = new FormData(event.target);
  const res = await act('player:join', { code: data.get('code'), name: data.get('name') });
  if (res.ok) {
    saveSession({ code: res.code, playerId: res.playerId });
    render();
  }
});

render();
