# Coin Game Online

Versão online multijogador do Coin Game, simulação Lean sobre tamanho de lote.
Salas de 3 a 5 jogadores, com um facilitador que admite os jogadores e controla a partida.

## Como rodar

```bash
npm install
npm start           # http://localhost:3000  (variável PORT para mudar)
npm test            # testes da regra de negócio e integração via Socket.IO
```

Para usar com colegas em outra rede, hospede o processo em um serviço Node (Render, Railway, Fly.io)
ou exponha a porta local com um túnel. Como o estado fica em memória, o processo precisa ficar ligado
durante a sessão. Reiniciar o servidor encerra as salas em andamento.

## Fluxo

1. Facilitador clica em **Criar sala** e compartilha o código.
2. Jogadores informam nome ou apelido e o código, e aguardam na pré-sala.
3. Facilitador clica em **Iniciar jogo** (exige de 3 a 5 jogadores). O número de estações é igual ao de jogadores presentes.
4. Rodadas na ordem 20 → 10 → 5 → 2. Ao fim de cada uma, o facilitador avança manualmente.
5. Ao fim da rodada de 2, o facilitador pode baixar o relatório (CSV), reiniciar com os jogadores da sala ou encerrar.

## Regras implementadas

- Cronômetro total: do primeiro clique da rodada até a última moeda chegar ao cliente.
- Cronômetro de primeira entrega: do primeiro clique até a primeira moeda chegar ao cliente.
- A bancada da primeira estação começa sempre com as 20 moedas, em todas as rodadas. Nas rodadas de 10, 5 e 2, o jogador vira e passa grupos desse tamanho, e as moedas restantes ficam visíveis na bancada.
- Passar adiante só habilita quando todas as moedas do grupo foram viradas nessa estação.
- Uma estação só recebe o próximo sublote depois de passar o anterior (sem esperar a cadeia inteira).
- Parar ou reiniciar zera contadores e tabela. Nada é persistido.
- Não há entrada após o início da partida.
- Desconexão pausa a partida e congela os cronômetros. Sem reconexão em 30 s, o jogador sai,
  e os lotes seguem para a próxima estação ativa (ou direto ao cliente, se ele era o último).
- Abaixo de 3 jogadores ativos, a partida é encerrada.

## Premissas que não estavam no roteiro (confirmar)

- Se o facilitador cair, a partida pausa e, após 30 s, a sala é encerrada.
- Se a sala está na pré-sala e um jogador cai, ele sai da sala imediatamente (sem prazo de reconexão).
- O relatório só contém rodadas concluídas. Uma rodada interrompida não entra na tabela.
- Após a remoção, o jogador que voltar vira espectador até o reinício.
- O relatório é gerado no navegador do facilitador a partir do estado do servidor (CSV com `;`, formato pt-BR).

## Estrutura

```
src/engine.js      regras da partida (máquina de estados, sem socket e com relógio injetável)
src/server.js      Socket.IO, salas, reconexão com prazo de 30 s
public/            interface (HTML, CSS e JS sem build)
test/              testes do engine e de integração
```
