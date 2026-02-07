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

// chama o worker (ingest telegram)
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

// ✅ helper: manda imagem pro Worker /api/ai/parse-ticket
async function sendImageToWorker({ telegram_id, chat_id, message_id, fileUrl, filename }) {
  const imgResp = await fetch(fileUrl);
  if (!imgResp.ok) throw new Error("Falha ao baixar imagem do Telegram");

  const buf = Buffer.from(await imgResp.arrayBuffer());

  const form = new FormData();
  form.append("telegram_id", telegram_id);
  form.append("chat_id", chat_id);
  form.append("message_id", message_id);
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

bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

bot.start(async (ctx) => {
  await ctx.reply(
`✅ BagresPlanilhador conectado!

1) Para vincular sua conta do site:
• Gere o código no site (Perfil → Vincular Telegram)
• Depois envie aqui: /vincular 123456

2) Depois de vinculado:
• +30 betano
• -50 bet365

📸 Envie um print do bilhete para testar leitura (modo teste).`
  );
});

// ✅ /vincular 123456
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

// ✅ FOTO normal (galeria/câmera)
bot.on("photo", async (ctx) => {
  try {
    console.log("PHOTO RECEIVED");

    const telegram_id = String(ctx.from?.id || "").trim();
    const chat_id = String(ctx.chat?.id || "").trim();
    const message_id = String(ctx.message?.message_id || "").trim();

    const photos = ctx.message.photo || [];
    const best = photos[photos.length - 1];
    if (!best?.file_id) {
      await ctx.reply("❌ Não achei o file_id da foto.");
      return;
    }

    const link = await ctx.telegram.getFileLink(best.file_id);

    const { res, data } = await sendImageToWorker({
      telegram_id,
      chat_id,
      message_id,
      fileUrl: link.href,
      filename: "ticket.jpg",
    });

    if (!res.ok) {
      console.log("WORKER ERROR:", res.status, data);
      if (data?.code === "NOT_LINKED") {
        await ctx.reply("⚠️ Seu Telegram ainda não está vinculado. Use /vincular 123456.");
        return;
      }
      await ctx.reply(`❌ Worker erro (${res.status}): ${data?.message || "Falha"}`);
      return;
    }

    await ctx.reply(
      `✅ Worker recebeu a imagem (modo teste)\n` +
      `user_id: ${data.user_id}\n` +
      `arquivo: ${data.file?.name} (${data.file?.type || "sem-type"})\n` +
      `tamanho: ${data.file?.size} bytes`
    );
  } catch (e) {
    console.error("PHOTO HANDLER ERROR:", e);
    await ctx.reply("❌ Deu erro ao processar a foto. Tenta novamente.");
  }
});

// ✅ Se a imagem for enviada como ARQUIVO (document)
bot.on("document", async (ctx) => {
  try {
    console.log("DOCUMENT RECEIVED");

    const telegram_id = String(ctx.from?.id || "").trim();
    const chat_id = String(ctx.chat?.id || "").trim();
    const message_id = String(ctx.message?.message_id || "").trim();

    const doc = ctx.message.document;
    const mime = String(doc?.mime_type || "");
    const name = String(doc?.file_name || "ticket.jpg");

    if (!mime.startsWith("image/")) {
      await ctx.reply("📎 Recebi um arquivo, mas não parece imagem. Envie como foto/imagem.");
      return;
    }

    const link = await ctx.telegram.getFileLink(doc.file_id);

    const { res, data } = await sendImageToWorker({
      telegram_id,
      chat_id,
      message_id,
      fileUrl: link.href,
      filename: name,
    });

    if (!res.ok) {
      console.log("WORKER ERROR:", res.status, data);
      if (data?.code === "NOT_LINKED") {
        await ctx.reply("⚠️ Seu Telegram ainda não está vinculado. Use /vincular 123456.");
        return;
      }
      await ctx.reply(`❌ Worker erro (${res.status}): ${data?.message || "Falha"}`);
      return;
    }

    await ctx.reply(
      `✅ Worker recebeu a imagem (modo teste)\n` +
      `user_id: ${data.user_id}\n` +
      `arquivo: ${data.file?.name} (${data.file?.type || "sem-type"})\n` +
      `tamanho: ${data.file?.size} bytes`
    );
  } catch (e) {
    console.error("DOCUMENT HANDLER ERROR:", e);
    await ctx.reply("❌ Deu erro ao processar o arquivo. Tenta novamente.");
  }
});

// ✅ +30 betano / -50 bet365
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

// ✅ WEBHOOK (resolve 409)
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

