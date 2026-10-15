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

// ATUALIZAÇÃO: Modelo alterado para a versão "Llama 3.1 8B Instant", que está 
// 100% disponível, funcional e otimizada para contas do plano gratuito (Developer Tier).
const GROQ_MODEL = 'llama-3.1-8b-instant'; 

// ==========================================
// FILA DE MENSAGENS (MESSAGE QUEUE)
// Previne bloqueios (Rate Limit) na API da Groq
// ==========================================
const messageQueue = [];
let isProcessingQueue = false;

// Intervalo entre as chamadas da Groq (em milissegundos)
const QUEUE_DELAY = 1500; 
// Máximo de mensagens na fila antes de começar a ignorar novos spams
const MAX_QUEUE_SIZE = 30;

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        // Retira a primeira tarefa da fila
        const task = messageQueue.shift();
        
        try {
            await task();
        } catch (err) {
            console.error("[ERRO NA FILA DO BOT]", err.message);
        }

        // Aguarda antes de prosseguir para a próxima (Rate Limit Control)
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

    // MODERAÇÃO ANTI-SPAM (URL BAN) - Continua sempre a vigiar o grupo em silêncio
    const hasLink = msg.entities && msg.entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
    if (hasLink) {
        try {
            await bot.deleteMessage(chatId, msg.message_id);
            await bot.banChatMember(chatId, userId);
            return; 
        } catch (error) {
            // Silencioso se não tiver permissão de admin
        }
    }

    if (!text) return;

    if (text === '/start') {
        return bot.sendMessage(chatId, "Olá! Sou o assistente virtual de IA da Bisq Investimentos. Como posso ajudar hoje?");
    }

    // ==========================================
    // REGRA DE SILÊNCIO NO GRUPO
    // ==========================================
    if (isGroup) {
        // Verifica se o bot foi mencionado (ex: @bisqmozBot)
        const isMentioned = botUsername && text.includes(`@${botUsername}`);
        
        // Verifica se o utilizador está a responder (Reply) a uma mensagem enviada pelo bot
        const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from.id === botId;
        
        // Se NÃO foi mencionado e NÃO é uma resposta a ele, o bot ignora e deixa os usuários falarem
        if (!isMentioned && !isReplyToBot) {
            return; 
        }
    }

    // Limpa a tag do bot da mensagem para não confundir a Inteligência Artificial
    const promptText = botUsername ? text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim() : text.trim();
    if (!promptText) return;

    // Se houver Spam imenso, o bot ignora requisições novas
    if (messageQueue.length >= MAX_QUEUE_SIZE) {
        console.log(`[AVISO] Fila do Bot cheia. Ignorando requisição.`);
        return;
    }

    // Adiciona o trabalho da Groq na fila
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
            
            // FILTRO ADICIONAL: Remove asteriscos e caracteres de markdown indesejados
            reply = reply.replace(/[*_~`#]/g, '');
            
            await bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });

        } catch (error) {
            console.error("=============== ERRO DA GROQ ===============");
            console.error(error.message);
            
            // Só responde com erro se não for erro de rate limit, para não encher o grupo de lixo se a API cair.
            if (!error.message.toLowerCase().includes('rate limit')) {
                await bot.sendMessage(chatId, "Infelizmente não consegui processar a sua questão devido a um erro técnico da plataforma. O administrador irá ajudá-lo em breve.", { reply_to_message_id: msg.message_id });
            }
        }
    });

    // Arranca a fila se ela estiver parada
    processQueue();
});