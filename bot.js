require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = 'llama3-70b-8192';

let botUsername = '';
let botId = '';

// Inicia as informações do bot UMA ÚNICA VEZ ao arrancar para evitar atrasos (Rate Limit)
bot.getMe().then((info) => {
    botUsername = info.username;
    botId = info.id;
    console.log(`Bot iniciado com sucesso como @${botUsername} e pronto a moderar.`);
}).catch(err => {
    console.error("Erro ao contactar a API do Telegram no arranque:", err.message);
});

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

    // ==========================================
    // MODERAÇÃO ANTI-SPAM (APAGA LINKS)
    // ==========================================
    const hasLink = msg.entities && msg.entities.some(entity => entity.type === 'url' || entity.type === 'text_link');

    if (hasLink) {
        try {
            await bot.deleteMessage(chatId, msg.message_id);
            await bot.banChatMember(chatId, userId);
            return; 
        } catch (error) {
            console.error("Erro na moderação (Verifique se o Bot é Administrador):", error.message);
        }
    }

    if (!text) return; // Ignora mensagens que não sejam texto (ex: imagens sem legenda)

    // ==========================================
    // IA - RESPOSTAS A PERGUNTAS
    // ==========================================
    const isPrivate = msg.chat.type === 'private';
    const isMentioned = botUsername && text.includes(`@${botUsername}`);
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from.id === botId;

    if (isPrivate || isMentioned || isReplyToBot) {
        
        const promptText = botUsername ? text.replace(`@${botUsername}`, '').trim() : text.trim();
        if (!promptText) return;

        // Ativa o estado de estar a escrever
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
            console.error("Erro na API da Groq:", error.message);
            // RESOLUÇÃO: Se a API falhar, o bot avisa o utilizador em vez de ficar apenas a piscar "digitando..."
            await bot.sendMessage(chatId, "Desculpe, estou a ter dificuldades técnicas de comunicação com a minha IA no momento. Tente novamente mais tarde.", { reply_to_message_id: msg.message_id });
        }
    }
});