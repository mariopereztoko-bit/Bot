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

// ATUALIZAÇÃO DEFINITIVA: O modelo "mixtral-8x7b-32768" é um dos mais estáveis, 
// rápidos e que nunca é bloqueado no plano gratuito da Groq.
const GROQ_MODEL = 'mixtral-8x7b-32768'; 

// ==========================================
// FILA DE MENSAGENS (MESSAGE QUEUE)
// ==========================================
const messageQueue = [];
let isProcessingQueue = false;

const QUEUE_DELAY = 1500; 
const MAX_QUEUE_SIZE = 30;

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const task = messageQueue.shift();
        
        try {
            await task();
        } catch (err) {
            console.error("[ERRO NA FILA DO BOT]", err.message);
        }

        await new Promise(resolve => setTimeout(resolve, QUEUE_DELAY));
    }

    isProcessingQueue = false;
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
async function iniciarBot() {
    try {
        const info = await bot.getMe();
        botUsername = info.username;
        botId = info.id;
        console.log(`[SUCESSO] Bot do Telegram iniciado como @${botUsername}`);
    } catch (err) {
        console.error("=============== ERRO DE ARRANQUE ===============");
        console.error("Verifique a sua GROQ_API_KEY ou TELEGRAM_BOT_TOKEN no ficheiro .env!");
        console.error(err.message);
        console.error("================================================");
    }
}

iniciarBot();

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
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (msg.from.is_bot) return; 

    // ==========================================
    // SISTEMA DE BOAS-VINDAS NO GRUPO
    // ==========================================
    if (msg.new_chat_members) {
        for (const member of msg.new_chat_members) {
            // Ignora se o novo membro for o próprio bot
            if (member.id === botId) continue;
            
            const welcomeText = `Olá, ${member.first_name}! Bem-vindo(a) ao grupo oficial da Bisq Investimentos.\n\nSou o assistente virtual de IA. Para fazer perguntas e receber respostas imediatamente aqui no grupo, lembre-se sempre de mencionar o meu nome (exemplo: @${botUsername}) na sua mensagem, ou de responder diretamente a uma mensagem minha.`;
            
            try {
                await bot.sendMessage(chatId, welcomeText);
            } catch (error) {
                console.error("Erro ao enviar boas-vindas", error.message);
            }
        }
        return; // Interrompe para não processar a entrada como uma mensagem de chat para a IA
    }

    // MODERAÇÃO ANTI-SPAM
    const hasLink = msg.entities && msg.entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
    if (hasLink) {
        try {
            await bot.deleteMessage(chatId, msg.message_id);
            await bot.banChatMember(chatId, userId);
            return; 
        } catch (error) {
            // Silencioso se não tiver permissão
        }
    }

    if (!text) return;

    if (text === '/start') {
        const startText = `Olá! Sou o assistente virtual de IA da Bisq Investimentos.\n\nComo posso ajudar hoje?\n\nDica: Se estiver a falar no grupo, lembre-se de me mencionar (ex: @${botUsername}) ou responder a uma mensagem minha para que eu saiba que está a falar comigo.`;
        return bot.sendMessage(chatId, startText);
    }

    if (isGroup) {
        const isMentioned = botUsername && text.includes(`@${botUsername}`);
        const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from.id === botId;
        
        if (!isMentioned && !isReplyToBot) {
            return; 
        }
    }

    const promptText = botUsername ? text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim() : text.trim();
    if (!promptText) return;

    if (messageQueue.length >= MAX_QUEUE_SIZE) {
        console.log(`[AVISO] Fila do Bot cheia. Ignorando requisição.`);
        return;
    }

    messageQueue.push(async () => {
        bot.sendChatAction(chatId, 'typing');

        try {
            const regrasAtuais = getRules();
            
            const systemPrompt = `Você é o assistente virtual oficial do grupo da Bisq Investimentos.
Seja educado e responda SEMPRE em Português de Moçambique de forma direta e sem usar emojis.
NÃO use formatação markdown, não use negrito e NUNCA use asteriscos no seu texto.

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

            let reply = chatCompletion.choices[0]?.message?.content || "Infelizmente não tenho essa informação, mas o administrador irá responder à sua questão em breve.";
            
            reply = reply.replace(/[*_~`#]/g, '');
            
            await bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });

        } catch (error) {
            console.error("=============== ERRO DETALHADO DA GROQ ===============");
            console.error(error.message);
            console.error(error);
            console.error("======================================================");
            
            if (!error.message.toLowerCase().includes('rate limit')) {
                await bot.sendMessage(chatId, "Infelizmente não consegui processar a sua questão devido a um erro técnico da plataforma. O administrador irá ajudá-lo em breve.", { reply_to_message_id: msg.message_id });
            }
        }
    });

    processQueue();
});