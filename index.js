
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== TEST BUTTON COMMAND =====
bot.command("teste", async (ctx) => {
  await ctx.reply(
    "Botão de teste:",
    Markup.inlineKeyboard([
      [Markup.button.callback("✏️ Editar 1", "edit:1:1")]
    ])
  );
});

// ===== UNIVERSAL CALLBACK LOGGER =====
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data;
  console.log("CALLBACK RECEBIDO:", data);

  await ctx.answerCbQuery(`Clique recebido: ${data || "sem data"}`);

  // ===== SIMPLE EDIT FLOW EXAMPLE =====
  if (data?.startsWith("edit:")) {
    const [, batchId, item] = data.split(":");

    await ctx.reply(
      `Editando aposta ${item} do lote ${batchId}. Escolha o campo:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Casa", `field:${batchId}:${item}:casa`)],
        [Markup.button.callback("Stake", `field:${batchId}:${item}:stake`)],
        [Markup.button.callback("Descrição", `field:${batchId}:${item}:descricao`)],
        [Markup.button.callback("Mercado", `field:${batchId}:${item}:mercado`)],
        [Markup.button.callback("Odds", `field:${batchId}:${item}:odds`)],
        [Markup.button.callback("Esporte", `field:${batchId}:${item}:esporte`)],
      ])
    );
  }

  if (data?.startsWith("field:")) {
    const [, batchId, item, field] = data.split(":");

    await ctx.reply(`Digite o novo valor para **${field}** da aposta ${item}:`, {
      parse_mode: "Markdown"
    });
  }
});

bot.launch();
console.log("🤖 Bot rodando...");
