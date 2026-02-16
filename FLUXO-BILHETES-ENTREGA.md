# BagrePlanilhador — Fluxo de bilhetes: entrega

## A) Diagnóstico

### Handlers de `callback_query` (bot.on / bot.action)

| Padrão | Onde (aprox.) | Função |
|--------|----------------|--------|
| `review:token:page` | ~254 + action | Paginação da mensagem "Revisão do lote" (⬅️ ➡️) |
| `editpick:token:index` | action | Escolhe qual aposta editar no lote → mostra botões de campo |
| `edit:token` | action | Abre edição: 1 item = campos direto; lote = lista Aposta 1, 2... |
| `ef:token:index:field` | action | Inicia edição por campo (Casa, Stake, etc.) → guarda em pendingEdits |
| `eback:token` | action | Voltar da tela de campos para a mensagem de revisão |
| `remove:token:index` | action | Remove item do lote e re-renderiza a revisão |
| `confirm:token` | action | Envia lote para Worker e mostra resultado |
| `cancel:token` | action | Descarta o lote |

### Estrutura de armazenamento do “lote em revisão”

- **`pendingBatches`** (Map): `token` → `{ telegram_id, chat_id, book, items: [{ extracted, summary_ }], review_message_id }`
  - Token único por lote (gerado em `queueReviewItem` e no timeout do álbum).
  - Usado em: `renderBatchReview`, confirm, cancel, edit, editpick, remove, e no handler de texto (ao salvar campo).

- **`chatReviewSessions`** (Map): `chat_id` → `{ telegram_id, chat_id, book, items, timer }`
  - Agrupa fotos únicas enviadas em sequência; após 3s vira um lote em `pendingBatches` e some daqui.

- **`pendingEdits`** (Map): `chat_id:telegram_id` → `{ token, index, mode, field?, reply_to }`
  - Modo `"field"`: usuário escolheu um campo (ef) e está respondendo com o novo valor.
  - Chave por chat+user evita conflito em grupo.

- **`pendingMediaGroups`** / **`pendingMediaGroupTimers`**: buffer do álbum do Telegram; ao terminar (900 ms) gera um único lote e uma única mensagem de revisão.

---

## B) Arquivos alterados e motivo

**Só 1 arquivo:** `bagres-bot/index.js`

- **Import:** `Markup` do Telegraf (para `Markup.button.callback` / teclados inline).
- **pendingEdits:** chave de `chat_id` para `chat_id:telegram_id` para não misturar usuários no mesmo grupo.
- **Resposta ao salvar campo:** "✅ Salvo com sucesso." e re-render com `editMessageId: batch?.review_message_id` para não duplicar mensagem.
- **renderBatchReview:** persiste `batch.review_message_id` ao editar ou enviar a mensagem de revisão (para reutilizar na mesma mensagem ao voltar/remover/paginar).
- **queueReviewItem:** já gerava 1 mensagem por lote (timer 3s); sem mudança de regra.
- **Álbum (media_group):** uso de `entry.messages` em vez de tratar o objeto como array; `createToken()` → `genToken()`; estrutura do batch alinhada ao resto (book, items, review_message_id).
- **Teclado de revisão:** um único botão "✏️ Editar" com `edit:token`; botões "Remover 1", "Remover 2" etc. mantidos.
- **Fluxo Editar:**
  - **Foto única:** "Editar" → botões de campo (Casa, Descrição, Mercado, Odds, Stake, Esporte) → resposta do usuário → "✅ Salvo com sucesso."
  - **Lote:** "Editar" → "Qual aposta?" (Aposta 1, Aposta 2, …) → botões de campo → resposta → "✅ Salvo com sucesso."
- **Prompts por campo** (EDIT_FIELD_UI) conforme especificado: Casa, Stake, Descrição, Mercado, Odds, Esporte.
- **confirm:** token validado; delete do token antes do request para evitar double-submit; mensagem de erro clara em caso de falha HTTP/resposta do Worker; sucesso com contagem de OK/falhas.
- **review:** handler de paginação (⬅️ ➡️) reutilizando a mesma mensagem via `editMessageId`.
- **remove:** passa `editMessageId: batch.review_message_id` para atualizar a mesma mensagem de revisão.

---

## C) Trechos principais

- **Chave de pendingEdits e resposta ao salvar campo (text handler):**
```js
const chatKey = `${ctx.chat?.id}:${ctx.from?.id}`;
// ...
await ctx.reply(`✅ Salvo com sucesso.`);
await renderBatchReview(ctx, pe.token, { page: 0, editMessageId: batch?.review_message_id });
```

- **Álbum: uso de entry.messages e genToken:**
```js
const entry = pendingMediaGroups.get(media_group_id);
// ...
for (const { msg, hint } of entry.messages) {
  const r = await processMessage(msg, hint || book_hint);
  // ...
}
const token = genToken();
pendingBatches.set(token, { telegram_id, chat_id, book, items, review_message_id: null });
```

- **Teclado: um "Editar" e callback_data:**
```js
kb.push([{ text: "✏️ Editar", callback_data: `edit:${token}` }]);
```

- **Confirm: evita double-submit e mensagem de erro:**
```js
pendingBatches.delete(token); // antes do fetch
// ...
if (!res.ok) {
  await ctx.editMessageText(`❌ Não foi possível gravar.`);
  await ctx.reply(`❌ Erro: ${msg || "Tente de novo mais tarde."}`);
  return;
}
```

- **Payload para o Worker:** continua `kind: "bets_create"`, `telegram_id`, `items: batch.items.map(x => x.extracted)`. O campo **Linha** não é enviado (não existe no bot).

---

## D) Como testar

### Local

1. **Env vars** (`.env` ou export):
   - `BOT_TOKEN` — token do BotFather  
   - `WORKER_BASE` — ex: `https://bagres.matheuspulga-mp.workers.dev`  
   - `INGEST_KEY` — chave de ingestão do Worker  
   - `PORT` — ex: 3000  
   - `PUBLIC_URL` — URL pública do servidor (ex: ngrok)  
   - `WEBHOOK_SECRET` — ex: bagres  

2. **Webhook:** com o servidor no ar, o próprio `index.js` chama `setWebhook(PUBLIC_URL + /telegraf/WEBHOOK_SECRET)`. Em local, use um túnel (ngrok/cloudflared) e coloque essa URL em `PUBLIC_URL`.

3. **Rodar:** `npm install` e `npm start` (ou `node index.js`).

4. **Testes no Telegram:**
   - **Foto única:** enviar 1 foto (com legenda = casa) → deve aparecer 1 mensagem "Revisão do lote" com 1 item, botão "✏️ Editar" → campos → responder → "✅ Salvo com sucesso." e a mesma mensagem atualizada.
   - **Lote (várias fotos em sequência):** enviar 2–3 fotos seguidas → após ~3s, 1 mensagem com todos os itens → "Editar" → Aposta 1 / Aposta 2 → campos → "✅ Salvo com sucesso."
   - **Álbum (múltiplas na mesma mensagem):** enviar 2+ fotos em um álbum → 1 "Lendo lote..." e depois 1 "Revisão do lote" com todos.
   - **Confirmar:** "Confirmar lote" → deve chamar o Worker; em erro (ex: NOT_LINKED ou 500), deve aparecer "❌ Erro: ..." em nova mensagem.
   - **Remover / Voltar:** Remover um item e "Voltar" após editar campo devem manter uma única mensagem de revisão (sem duplicar).

### Railway

1. Variáveis no dashboard: `BOT_TOKEN`, `WORKER_BASE`, `INGEST_KEY`, `PUBLIC_URL` (URL do serviço Railway), opcionalmente `WEBHOOK_SECRET` e `PORT`.
2. Deploy do repositório; o start é o mesmo (`node index.js` / `npm start`).
3. Repetir os mesmos fluxos (foto única, lote, álbum, editar, confirmar, erro) pelo Telegram.

---

## Resumo

- **Arquivo alterado:** apenas `bagres-bot/index.js`.
- **Fluxo:** uma mensagem de revisão por lote; Editar com campos (foto única direto, lote com escolha de aposta); prompts por campo conforme especificado; Confirm envia para o Worker com mensagem de erro clara e sem double-submit.
- **Campo "Linha":** não existe no bot; o payload para o Worker não inclui `line`.
