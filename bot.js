require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let botUsername = '';
let botId = '';
let GROQ_MODEL = 'openai/gpt-oss-20b'; // Modelo de segurança caso a busca falhe

// ==========================================
// INICIALIZAÇÃO E AUTO-SELEÇÃO DE MODELO
// ==========================================
async function iniciarBot() {
    try {
        // 1. Inicia o Telegram
        const info = await bot.getMe();
        botUsername = info.username;
        botId = info.id;
        console.log(`[SUCESSO] Bot do Telegram iniciado como @${botUsername}`);

        // 2. Procura automaticamente um modelo válido da Groq
        const modelos = await groq.models.list();
        if (modelos && modelos.data && modelos.data.length > 0) {
            // Pega no primeiro modelo disponível na sua conta
            GROQ_MODEL = modelos.data[0].id;
            console.log(`[SUCESSO] Modelo da Groq selecionado automaticamente: ${GROQ_MODEL}`);
        }
    } catch (err) {
        console.error("=============== ERRO DE ARRANQUE ===============");
        console.error("Verifique a sua GROQ_API_KEY ou TELEGRAM_BOT_TOKEN no ficheiro .env!");
        console.error(err.message);
        console.error("================================================");
    }
}

iniciarBot();

// ==========================================
// LER REGRAS
// ==========================================
const getRules = () => {
    try {
        return fs.readFileSync(path.join(__dirname, 'regras.txt'), 'utf8');
    } catch (err) {
        console.error("Erro ao ler regras.txt:", err);
        return "Regras não disponíveis no momento.";
    }
};

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text || '';

    if (msg.from.is_bot) return; 

    // MODERAÇÃO ANTI-SPAM
    const hasLink = msg.entities && msg.entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
    if (hasLink) {
        try {
            await bot.deleteMessage(chatId, msg.message_id);
            await bot.banChatMember(chatId, userId);
            return; 
        } catch (error) {
            // Silencioso se não for admin
        }
    }

    if (!text) return;

    // IGNORA COMANDO START (Não gasta IA atoa)
    if (text === '/start') {
        return bot.sendMessage(chatId, "Olá! Sou o assistente virtual da Bisq Investimentos. Como posso ajudar hoje?");
    }

    const promptText = botUsername ? text.replace(`@${botUsername}`, '').trim() : text.trim();
    if (!promptText) return;

    bot.sendChatAction(chatId, 'typing');

    try {
        const regrasAtuais = getRules();
        
        const systemPrompt = `Você é o assistente virtual oficial do grupo da Bisq Investimentos.
Seja educado e responda SEMPRE em Português de Moçambique de forma direta e sem usar emojis.

A sua única fonte de conhecimento é o texto abaixo. Leia com muita atenção:
---
${regrasAtuais}
---

REGRA DE OURO: Se o utilizador fizer uma pergunta cuja resposta NÃO ESTEJA EXPLICITAMENTE MENCIONADA no texto acima, você não deve inventar nem deduzir nada. Nesses casos, responda EXATAMENTE com a seguinte frase e nada mais:
"Infelizmente não tenho essa informação, mas o administrador irá responder à sua questão em breve."`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: promptText }
            ],
            model: GROQ_MODEL,
            temperature: 0.1, 
            max_tokens: 512
        });

        const reply = chatCompletion.choices[0]?.message?.content || "Infelizmente não tenho essa informação, mas o administrador irá responder à sua questão em breve.";
        
        await bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });

    } catch (error) {
        console.error("=============== ERRO DA GROQ NO CHAT ===============");
        console.error(`Modelo tentado: ${GROQ_MODEL}`);
        console.error(error.message);
        console.error("====================================================");
        
        await bot.sendMessage(chatId, "Desculpe, estou a ter dificuldades técnicas de comunicação com a minha IA no momento. Tente novamente mais tarde.", { reply_to_message_id: msg.message_id });
    }
});