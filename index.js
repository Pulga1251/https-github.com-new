import http from "http";
import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import FormData from "form-data";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WORKER_BASE = (process.env.WORKER_BASE || "").replace(/\/+$/, "");
const INGEST_KEY = String(process.env.INGEST_KEY || "").replace(/[\r\n\t]/g, "").trim();

if (!BOT_TOKEN) throw new Error("Faltou BOT_TOKEN.");
if (!WORKER_BASE) throw new Error("Faltou WORKER_BASE.");
if (!INGEST_KEY) throw new Error("Faltou INGEST_KEY.");

const bot = new Telegraf(BOT_TOKEN);

// =======================
// Helpers
// =======================
function parseMoney(s) {
  const n = Number(String(s || "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function slugifyBook(raw) {
  let s = String(raw || "").trim().toLowerCase();
  try {
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {}
  s = s.replace(/&/g, "e");
  s = s.replace(/[^a-z0-9]+/g, "");
  return s;
}

function normalizeBook(s) {
  return slugifyBook(s);
}

function moneyBR(v) {
  const n = Number(v || 0);
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function genToken() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// =======================
// Worker calls
// =======================
async function ingestTelegram(payload) {
  const res = await fetch(`${WORKER_BASE}/api/ingest/telegram`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-INGEST-KEY": INGEST_KEY,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Erro ${res.status}`);
  return data;
}

async function sendImageToWorker({ telegram_id, chat_id, fileUrl, filename, book_hint }) {
  const imgResp = await fetch(fileUrl);
  if (!imgResp.ok) throw new Error("Falha ao baixar imagem do Telegram");

  const buf = Buffer.from(await imgResp.arrayBuffer());

  const form = new FormData();
  form.append("telegram_id", telegram_id);
  form.append("chat_id", chat_id);
  if (book_hint) form.append("book_hint", book_hint);
  form.append("image", buf, { filename: filename || "ticket.jpg", contentType: "image/jpeg" });

  const res = await fetch(`${WORKER_BASE}/api/ai/parse-ticket`, {
    method: "POST",
    headers: {
      "X-INGEST-KEY": INGEST_KEY,
      ...form.getHeaders(),
    },
    body: form,
  });

  const data = await res.json().catch(() => null);
  return { res, data };
}

// =======================
// Batch memory (confirm A)
// =======================
const pendingBatches = new Map(); // token -> { telegram_id, book, items:[{extracted, summary_}] }
const mediaGroups = new Map();
const pendingEdits = new Map();  // chat_id -> { token, index }
    // key -> { telegram_id, chat_id, book, items, timer }


function summarizeExtracted(x) {
  const event = (x?.event || "").toString().trim();
  const market = (x?.market || "").toString().trim();
  const odd = (x?.odd ?? "").toString().trim();
  const stake = (x?.stake ?? "").toString().trim();
  const sport = (x?.sport || "").toString().trim();
  const book = (x?.book || "").toString().trim();

  let s = `${event || "(sem jogo)"} — ${market || "(sem mercado)"}`;
  if (odd) s += ` (odd ${odd})`;
  if (stake) s += ` • stake ${stake}`;
  if (sport) s += ` • ${sport}`;
  if (book) s += ` • ${book}`;
  return s;
}

function parseEditForm(text) {
  // Aceita:
  // Casa: ...
  // Descrição: ...
  // Mercado: ...
  // Odd: ...
  // Stake: ...
  // Esporte: ...
  const raw = String(text || "");

  const pick = (label) => {
    const re = new RegExp(`^\s*${label}\s*:\s*(.+?)\s*$`, "im");
    const mm = raw.match(re);
    return mm ? mm[1].trim() : "";
  };

  const out = {};
  const casa = pick("Casa");
  const desc = pick("Descri(?:ção|cao)");
  const mercado = pick("Mercado");
  const odd = pick("Odd");
  const stake = pick("Stake");
  const esporte = pick("Esporte");

  if (casa) out.book = casa;
  if (desc) out.event = desc; // usamos event como "descrição/jogo"
  if (mercado) out.market = mercado;
  if (odd) out.odd = Number(String(odd).replace(",", "."));
  if (stake) out.stake = Number(String(stake).replace(",", "."));
  if (esporte) out.sport = esporte;

  return out;
}

function applyEditToExtracted(original, text) {
  const patch = parseEditForm(text);
  const out = { ...(original || {}) };

  for (const [k, v] of Object.entries(patch)) {
    if (v !== "" && v !== null && v !== undefined && !(Number.isNaN(v) && (k === "odd" || k === "stake"))) {
      out[k] = v;
    }
  }

  // normaliza números caso venham como string
  if (out.odd !== undefined && out.odd !== null) out.odd = Number(String(out.odd).replace(",", "."));
  if (out.stake !== undefined && out.stake !== null) out.stake = Number(String(out.stake).replace(",", "."));

  // book sempre como slug interno
  if (out.book !== undefined && out.book !== null && String(out.book).trim()) {
    out.book = normalizeBook(out.book);
  }

  return out;
}


async function renderBatchReview(ctx, token, opts = {}) {
  const pageSize = 6;
  const page = Math.max(0, Number(opts.page || 0));
  const editMessageId = opts.editMessageId || null;

  const batch = pendingBatches.get(token);
  if (!batch) {
    try { await ctx.answerCbQuery?.("Esse lote expirou."); } catch {}
    return;
  }

  const total = (batch.items || []).length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(page, pages - 1);
  const start = p * pageSize;
  const end = Math.min(total, start + pageSize);

  const lines = [];
  lines.push(`📌 *Revisão do lote*`);
  lines.push(`🏷️ Casa: *${(batch.book || "—")}*`);
  lines.push(`📦 Itens: *${total}*`);
  lines.push("");
  if (total === 0) {
    lines.push("⚠️ Nenhum item no lote. Envie novas fotos.");
  } else {
    for (let i = start; i < end; i++) {
      const it = batch.items[i];
      const s = it?.summary_line || summarizeExtracted(it?.extracted || {});
      lines.push(`*${i + 1})* ${s}`);
    }
  }
  if (pages > 1) lines.push(`\nPágina ${p + 1}/${pages}`);

  const kb = [];

  if (total > 0) {
    for (let i = start; i < end; i++) {
      kb.push([
        { text: `✏️ Editar ${i + 1}`, callback_data: `edit:${token}:${i}` },
        { text: `🗑 Remover ${i + 1}`, callback_data: `remove:${token}:${i}` },
      ]);
    }
  }

  const nav = [];
  if (pages > 1 && p > 0) nav.push({ text: "⬅️", callback_data: `review:${token}:${p - 1}` });
  if (pages > 1 && p < pages - 1) nav.push({ text: "➡️", callback_data: `review:${token}:${p + 1}` });
  if (nav.length) kb.push(nav);

  kb.push([{ text: "✅ Confirmar lote", callback_data: `confirm:${token}` }]);
  kb.push([{ text: "❌ Cancelar", callback_data: `cancel:${token}` }]);

  const payload = {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: kb },
  };

  // tenta editar a mensagem existente (melhor UX)
  try {
    if (editMessageId && ctx.telegram && ctx.chat?.id) {
      await ctx.telegram.editMessageText(ctx.chat.id, editMessageId, null, lines.join("\n"), payload);
      return;
    }
    if (typeof ctx.editMessageText === "function" && ctx.updateType === "callback_query") {
      await ctx.editMessageText(lines.join("\n"), payload);
      return;
    }
  } catch (e) {
    // cai para reply
  }

  const msg = await ctx.reply(lines.join("\n"), payload);
  batch.review_message_id = msg.message_id;
}

async function sendConfirmMessage(ctx, book, items, token) {
  // Compat: agora usamos a revisão visual
  try { pendingBatches.set(token, { ...(pendingBatches.get(token) || {}), book, items }); } catch {}
  return renderBatchReview(ctx, token, { page: 0 });
}

// =======================
// Commands
// =======================
bot.start(async (ctx) => {
  await ctx.reply(
`✅ BagresPlanilhador conectado!

1) Para vincular sua conta do site:
• Gere o código no site (Perfil → Vincular Telegram)
• Depois envie aqui: /vincular 123456

2) Depois de vinculado:
• +30 betano
• -50 bet365

📸 Para lançar por bilhete:
Envie a foto do bilhete com a legenda = nome da casa (ex: "esportiva").`
  );
});

// /vincular 123456
bot.command("vincular", async (ctx) => {
  try {
    const parts = (ctx.message.text || "").trim().split(/\s+/);
    const code = parts[1];

    if (!code || !/^\d{6}$/.test(code)) {
      await ctx.reply("❌ Use assim: /vincular 123456 (6 dígitos)");
      return;
    }

    const telegram_id = String(ctx.from?.id || "").trim();
    const telegram_username = String(ctx.from?.username || "").trim();

    await ingestTelegram({
      kind: "link",
      code,
      telegram_id,
      telegram_username,
    });

    await ctx.reply("✅ Telegram vinculado com sucesso! Agora pode mandar: +30 betano");
  } catch (e) {
    await ctx.reply(`❌ Erro ao vincular: ${e.message}`);
  }
});

// =======================
// Wallet (+/-)
// =======================
bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  if (text.startsWith("/")) return;

  // se está em modo edição de bilhete (EDITAR = formulário numa única mensagem)
  const chatKey = String(ctx.chat?.id || "");
  const pe = pendingEdits.get(chatKey);
  if (pe) {
    // só aceita se for resposta ao "formulário" que o bot mandou
    const repliedId = ctx.message?.reply_to_message?.message_id;
    if (!repliedId || repliedId !== pe.reply_to) return;

    const batch = pendingBatches.get(pe.token);
    if (!batch || !batch.items[pe.index]) {
      pendingEdits.delete(chatKey);
      await ctx.reply("⚠️ Não achei esse lote/item. Tente enviar a foto de novo.");
      return;
    }

    const cur = batch.items[pe.index].extracted || {};
    const updated = applyEditToExtracted(cur, text);

    batch.items[pe.index].extracted = updated;
    batch.items[pe.index].summary_ = summarizeExtracted(updated);

    pendingEdits.delete(chatKey);

    await ctx.reply("✅ Atualizado! Vou te mostrar o lote atualizado:");
    await renderBatchReview(ctx, pe.token, { page: 0 });
    return;
  }

  const m = text.match(/^([+-])\s*([\d.,]+)\s+([a-zA-Z0-9._-]{2,})$/);
  if (!m) return;

  const sign = m[1];
  const amount = parseMoney(m[2]);
  const book = normalizeBook(m[3]);

  if (!amount || amount <= 0) {
    await ctx.reply("❌ Valor inválido.");
    return;
  }

  const telegram_id = String(ctx.from?.id || "").trim();
  const telegram_username = String(ctx.from?.username || "").trim();
  const type = sign === "+" ? "deposit" : "withdraw";

  try {
    await ingestTelegram({
      kind: "wallet",
      telegram_id,
      telegram_username,
      type,
      amount,
      book,
      note: `telegram:${telegram_id}`,
      source: `telegram:${telegram_id}`,
    });

    const action = type === "deposit" ? "DEPÓSITO" : "SAQUE";
    await ctx.reply(`💰 ${action} ${moneyBR(amount)} em ${book}`);
  } catch (e) {
    await ctx.reply(`❌ Erro ao registrar: ${e.message}`);
  }
});

// =======================
// Photo -> AI -> list -> confirm
// =======================
bot.on("photo", async (ctx) => {
  try {
    const telegram_id = String(ctx.from?.id || "").trim();
    const chat_id = String(ctx.chat?.id || "").trim();

    const caption = String(ctx.message.caption || "").trim(); // legenda = casa
    const book_hint = caption ? normalizeBook(caption) : "";

    const photos = ctx.message.photo || [];
    const best = photos[photos.length - 1];
    if (!best?.file_id) return ctx.reply("❌ Não achei o file_id.");

    const link = await ctx.telegram.getFileLink(best.file_id);
    const media_group_id = ctx.message.media_group_id ? String(ctx.message.media_group_id) : null;

    const processOne = async () => {
      const { res, data } = await sendImageToWorker({
        telegram_id,
        chat_id,
        fileUrl: link.href,
        filename: "ticket.jpg",
        book_hint,
      });

      if (!res.ok) {
        if (data?.code === "NOT_LINKED") {
          await ctx.reply("⚠️ Seu Telegram não está vinculado. Use /vincular 123456.");
          return null;
        }
        await ctx.reply(`❌ Erro no Worker (${res.status}): ${data?.message || "Falha"}`);
        return null;
      }
      return data;
    };

    // ✅ 1 foto
    if (!media_group_id) {
      const one = await processOne();
      if (!one) return;

      const token = genToken();
      pendingBatches.set(token, {
        telegram_id,
        book: book_hint,
        items: [{ extracted: one.extracted, summary_: one.summary_ }],
      });

      return sendConfirmMessage(ctx, book_hint, pendingBatches.get(token).items, token);
    }

    // ✅ álbum: acumula e fecha após 1.2s sem novas fotos
    const key = `${chat_id}:${media_group_id}`;
    let g = mediaGroups.get(key);
    if (!g) {
      g = { telegram_id, chat_id, book: book_hint, items: [], timer: null };
      mediaGroups.set(key, g);
    }
    if (book_hint) g.book = book_hint;

    const one = await processOne();
    if (one) g.items.push({ extracted: one.extracted, summary_: one.summary_ });

    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(async () => {
      mediaGroups.delete(key);

      const token = genToken();
      pendingBatches.set(token, {
        telegram_id: g.telegram_id,
        book: g.book,
        items: g.items,
      });

      await sendConfirmMessage(ctx, g.book, g.items, token);
    }, 1200);

  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Erro ao processar foto.");
  }
});



bot.action(/^edit:(.+):(\d+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const index = Number(ctx.match[2]);
    const batch = pendingBatches.get(token);
    if (!batch || !batch.items || !batch.items[index]) {
      await ctx.answerCbQuery("Esse item expirou.");
      return;
    }
    await ctx.answerCbQuery("Editar");

    const it = batch.items[index];
    const x = it.extracted || {};

    const formText =
`✏️ *Editar aposta ${index + 1}*
Responda *esta mensagem* mantendo o formato (pode apagar o que não quiser mudar):

Casa: ${x.book || batch.book || ""}
Descrição: ${x.event || ""}
Mercado: ${x.market || ""}
Odd: ${x.odd ?? ""}
Stake: ${x.stake ?? ""}
Esporte: ${x.sport || ""}

_Dica: só edite o valor depois dos dois pontos._`;

    const chatKey = String(ctx.chat?.id || "");
    const msg = await ctx.reply(formText, {
      parse_mode: "Markdown",
      reply_markup: { force_reply: true },
    });

    pendingEdits.set(chatKey, { token, index, reply_to: msg.message_id });
  } catch (e) {
    try { await ctx.answerCbQuery("Erro"); } catch {}
  }
});

bot.action(/^review:(.+):(\d+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const page = Number(ctx.match[2] || 0);
    const batch = pendingBatches.get(token);
    if (!batch) { await ctx.answerCbQuery("Esse lote expirou."); return; }
    await ctx.answerCbQuery("Ok");
    await renderBatchReview(ctx, token, { page });
  } catch (e) {
    try { await ctx.answerCbQuery("Erro"); } catch {}
  }
});

bot.action(/^remove:(.+):(\d+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const index = Number(ctx.match[2]);
    const batch = pendingBatches.get(token);
    if (!batch) { await ctx.answerCbQuery("Esse lote expirou."); return; }
    if (!batch.items || !batch.items[index]) { await ctx.answerCbQuery("Item inválido."); return; }

    batch.items.splice(index, 1);
    // recomputa summary_line se necessário
    batch.items.forEach((it) => {
      it.summary_line = it.summary_line || summarizeExtracted(it.extracted || {});
    });

    await ctx.answerCbQuery("Removido");
    await renderBatchReview(ctx, token, { page: 0 });
  } catch (e) {
    try { await ctx.answerCbQuery("Erro"); } catch {}
  }
});

// =======================
// Confirm / Cancel actions
// =======================
bot.action(/^confirm:(.+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const batch = pendingBatches.get(token);
    if (!batch) {
      await ctx.answerCbQuery("Esse lote expirou.");
      return;
    }

    await ctx.answerCbQuery("Gravando...");

    const res = await fetch(`${WORKER_BASE}/api/ingest/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-INGEST-KEY": INGEST_KEY },
      body: JSON.stringify({
        kind: "bets_create",
        telegram_id: batch.telegram_id,
        items: batch.items.map((x) => x.extracted),
      }),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || `Erro ${res.status}`);

    pendingBatches.delete(token);

    const okCount = (data.results || []).filter((r) => r.ok).length;
    const failCount = (data.results || []).filter((r) => !r.ok).length;

    await ctx.editMessageText(`✅ Lote gravado!\nOK: ${okCount}\nFalhas: ${failCount}`);
  } catch (e) {
    await ctx.answerCbQuery("Erro");
    await ctx.reply(`❌ Falha ao gravar: ${e.message}`);
  }
});

bot.action(/^cancel:(.+)$/i, async (ctx) => {
  const token = ctx.match[1];
  pendingBatches.delete(token);
  await ctx.answerCbQuery("Cancelado");
  try { await ctx.editMessageText("❌ Lote cancelado."); } catch {}
});

bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

// =======================
// Webhook server (resolve 409)
// =======================
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "bagres").trim();
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;

const server = http.createServer((req, res) => {
  if (req.url === webhookPath && req.method === "POST") {
    return bot.webhookCallback(webhookPath)(req, res);
  }
  res.statusCode = 200;
  res.end("ok");
});

server.listen(PORT, async () => {
  console.log(`🌐 Webhook server on :${PORT} path=${webhookPath}`);

  if (!PUBLIC_URL) {
    console.log("⚠️ PUBLIC_URL não definido. Configure no Railway (Variables).");
    return;
  }

  const webhookUrl = `${PUBLIC_URL}${webhookPath}`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log("✅ Webhook set:", webhookUrl);
  } catch (e) {
    console.error("❌ Falha ao setWebhook:", e);
  }
});
