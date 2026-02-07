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
function normalizeBook(s) {
  return String(s || "").trim().toLowerCase();
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
const pendingBatches = new Map(); // token -> { telegram_id, book, items:[{extracted, summary_line}] }
const mediaGroups = new Map();    // key -> { telegram_id, chat_id, book, items, timer }

async function sendConfirmMessage(ctx, book, items, token) {
  const lines = items
    .map((it, idx) => `${idx + 1}) ${it.summary_line || "(sem resumo)"}`)
    .join("\n");

  await ctx.reply(
    `📌 Casa: ${book || "(não informada)"}\n\n${lines}\n\nConfirmar tudo?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Confirmar tudo", callback_data: `confirm:${token}` }],
          [{ text: "❌ Cancelar", callback_data: `cancel:${token}` }],
        ],
      },
    }
  );
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
    const book_hint = caption ? caption.toLowerCase() : "";

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
        items: [{ extracted: one.extracted, summary_line: one.summary_line }],
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
    if (one) g.items.push({ extracted: one.extracted, summary_line: one.summary_line });

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
