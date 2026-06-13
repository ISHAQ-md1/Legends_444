const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const axios = require('axios');
const yts = require('yt-search');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  downloadContentFromMessage,
  DisconnectReason
} = require('@whiskeysockets/baileys');

// ========== LOCAL JSON STORAGE ==========
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const NUMBERS_FILE = path.join(DATA_DIR, 'numbers.json');
const ADMINS_FILE = path.join(DATA_DIR, 'admins.json');
const NEWSLETTERS_FILE = path.join(DATA_DIR, 'newsletters.json');
const CONFIGS_FILE = path.join(DATA_DIR, 'configs.json');

function initJSON(file, defaultData = {}) {
    if (!fs.existsSync(file)) {
        fs.writeJsonSync(file, defaultData, { spaces: 2 });
    }
}

initJSON(SESSIONS_FILE, {});
initJSON(NUMBERS_FILE, []);
initJSON(ADMINS_FILE, []);
initJSON(NEWSLETTERS_FILE, []);
initJSON(CONFIGS_FILE, {});

// Storage Functions
function saveCredsToLocal(number, creds, keys = null) {
    const sessions = fs.readJsonSync(SESSIONS_FILE);
    sessions[number] = { creds, keys, updatedAt: new Date().toISOString() };
    fs.writeJsonSync(SESSIONS_FILE, sessions, { spaces: 2 });
}

function loadCredsFromLocal(number) {
    const sessions = fs.readJsonSync(SESSIONS_FILE);
    return sessions[number] || null;
}

function removeSessionFromLocal(number) {
    const sessions = fs.readJsonSync(SESSIONS_FILE);
    delete sessions[number];
    fs.writeJsonSync(SESSIONS_FILE, sessions, { spaces: 2 });
}

function addNumberToLocal(number) {
    let numbers = fs.readJsonSync(NUMBERS_FILE);
    if (!numbers.includes(number)) {
        numbers.push(number);
        fs.writeJsonSync(NUMBERS_FILE, numbers, { spaces: 2 });
    }
}

function removeNumberFromLocal(number) {
    let numbers = fs.readJsonSync(NUMBERS_FILE);
    numbers = numbers.filter(n => n !== number);
    fs.writeJsonSync(NUMBERS_FILE, numbers, { spaces: 2 });
}

function getAllNumbersFromLocal() {
    return fs.readJsonSync(NUMBERS_FILE);
}

function loadAdminsFromLocal() {
    return fs.readJsonSync(ADMINS_FILE);
}

function addAdminToLocal(jidOrNumber) {
    let admins = fs.readJsonSync(ADMINS_FILE);
    if (!admins.includes(jidOrNumber)) {
        admins.push(jidOrNumber);
        fs.writeJsonSync(ADMINS_FILE, admins, { spaces: 2 });
    }
}

function removeAdminFromLocal(jidOrNumber) {
    let admins = fs.readJsonSync(ADMINS_FILE);
    admins = admins.filter(a => a !== jidOrNumber);
    fs.writeJsonSync(ADMINS_FILE, admins, { spaces: 2 });
}

function addNewsletterToLocal(jid, emojis = []) {
    let newsletters = fs.readJsonSync(NEWSLETTERS_FILE);
    const existing = newsletters.find(n => n.jid === jid);
    if (existing) {
        existing.emojis = emojis;
    } else {
        newsletters.push({ jid, emojis, addedAt: new Date().toISOString() });
    }
    fs.writeJsonSync(NEWSLETTERS_FILE, newsletters, { spaces: 2 });
}

function removeNewsletterFromLocal(jid) {
    let newsletters = fs.readJsonSync(NEWSLETTERS_FILE);
    newsletters = newsletters.filter(n => n.jid !== jid);
    fs.writeJsonSync(NEWSLETTERS_FILE, newsletters, { spaces: 2 });
}

function listNewslettersFromLocal() {
    return fs.readJsonSync(NEWSLETTERS_FILE);
}

function setUserConfigInLocal(number, config) {
    const configs = fs.readJsonSync(CONFIGS_FILE);
    configs[number] = config;
    fs.writeJsonSync(CONFIGS_FILE, configs, { spaces: 2 });
}

function loadUserConfigFromLocal(number) {
    const configs = fs.readJsonSync(CONFIGS_FILE);
    return configs[number] || {};
}

// ========== CONFIG ==========
const BOT_NAME_FANCY = 'ALONE MINI';

const config = {
  AUTO_VIEW_STATUS: 'true',
  AUTO_LIKE_STATUS: 'true',
  AUTO_RECORDING: 'false',
  AUTO_TYPING: 'false',
  AUTO_LIKE_EMOJI: ['☘️', '💗', '🫂', '🙈', '🍁', '🙃', '🧸', '😘', '🏴‍☠️', '👀', '❤️‍🔥'],
  PREFIX: '.',
  MAX_RETRIES: 3,
  GROUP_INVITE_LINK: 'https://chat.whatsapp.com/Hdf6sdiJKo48zsPHgsIbkg',
  RCD_IMAGE_PATH: 'https://i.ibb.co/XrhXt1jK/tourl-1766509613542.jpg',
  OTP_EXPIRY: 300000,
  OWNER_NUMBER: process.env.OWNER_NUMBER || '94714768679',
  BOT_NAME: 'ALONE MINI',
  BOT_VERSION: '6.0.0',
  OWNER_NAME: 'AKARSHANA',
  BOT_FOOTER: '> 𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 ALONE MINI 𝙾𝙵𝙲'
};

// ========== UTILS ==========
function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function downloadQuotedMedia(quotedMsg) {
    if (!quotedMsg) return null;
    const qTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
    const qType = qTypes.find(t => quotedMsg[t]);
    if (!qType) return null;
    const messageType = qType.replace(/Message$/i, '').toLowerCase();
    const stream = await downloadContentFromMessage(quotedMsg[qType], messageType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return { buffer, mime: quotedMsg[qType].mimetype || '', caption: quotedMsg[qType].caption || '', ptt: quotedMsg[qType].ptt || false, fileName: quotedMsg[qType].fileName || '' };
}

// ========== ACTIVE SESSIONS ==========
const activeSockets = new Map();
const socketCreationTime = new Map();

// ========== COMMAND HANDLER ==========
async function setupCommandHandlers(socket, sessionNumber) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const type = getContentType(msg.message);
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || from;
        const senderNumber = sender.split('@')[0];
        const botNumber = socket.user.id.split(':')[0];
        const isOwner = config.OWNER_NUMBER.replace(/[^0-9]/g, '') === senderNumber;
        
        let body = '';
        if (type === 'conversation') body = msg.message.conversation;
        else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
        else if (type === 'imageMessage' && msg.message.imageMessage.caption) body = msg.message.imageMessage.caption;
        else if (type === 'videoMessage' && msg.message.videoMessage.caption) body = msg.message.videoMessage.caption;
        
        if (!body) return;
        
        const prefix = config.PREFIX;
        if (!body.startsWith(prefix)) return;
        
        const command = body.slice(prefix.length).trim().split(' ')[0].toLowerCase();
        const args = body.trim().split(/\s+/).slice(1);
        
        try {
            // ========== MENU COMMAND ==========
            if (command === 'menu' || command === 'help') {
                const uptime = Math.floor((Date.now() - (socketCreationTime.get(sessionNumber) || Date.now())) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = uptime % 60;
                
                const menuText = `╭━━━❰ *${config.BOT_NAME}* ❱━━━╮
┃
┃ ✨ *HI ${senderNumber}* ✨
┃
┣━━━━━━━━━━━━━━━━━━━┫
┃ 📌 *BOT INFO*
┃ ├ 🤖 *Name:* ${config.BOT_NAME}
┃ ├ 👑 *Owner:* ${config.OWNER_NAME}
┃ ├ 📟 *Version:* ${config.BOT_VERSION}
┃ └ ⏱️ *Uptime:* ${hours}h ${minutes}m ${seconds}s
┃
┣━━━━━━━━━━━━━━━━━━━┫
┃ 🎮 *COMMANDS*
┃
┃ 🎵 *DOWNLOAD*
┃ ├ ${prefix}song <query>
┃ ├ ${prefix}ytmp3 <url>
┃ ├ ${prefix}ytmp4 <url>
┃ ├ ${prefix}tiktok <url>
┃ ├ ${prefix}instagram <url>
┃ ├ ${prefix}facebook <url>
┃ └ ${prefix}mediafire <url>
┃
┃ 🤖 *AI & TOOLS*
┃ ├ ${prefix}ai <message>
┃ ├ ${prefix}aiimg <prompt>
┃ ├ ${prefix}weather <city>
┃ ├ ${prefix}google <query>
┃ ├ ${prefix}img <query>
┃ └ ${prefix}font <text>
┃
┃ ⚙️ *SETTINGS*
┃ ├ ${prefix}setname <name>
┃ ├ ${prefix}setprefix <symbol>
┃ ├ ${prefix}autoread on/off
┃ ├ ${prefix}autoreact on/off
┃ └ ${prefix}antidelete on/off
┃
┃ 👑 *OWNER*
┃ ├ ${prefix}block <@tag>
┃ ├ ${prefix}unblock <@tag>
┃ ├ ${prefix}addadmin <jid>
┃ ├ ${prefix}deladmin <jid>
┃ └ ${prefix}broadcast <msg>
┃
┣━━━━━━━━━━━━━━━━━━━┫
┃ © ${config.BOT_NAME}
╰━━━━━━━━━━━━━━━━━━━╯`;
                
                await socket.sendMessage(from, { image: { url: config.RCD_IMAGE_PATH }, caption: menuText }, { quoted: msg });
                await socket.sendMessage(from, { react: { text: '📋', key: msg.key } });
            }
            
            // ========== ALIVE COMMAND ==========
            else if (command === 'alive' || command === 'ping') {
                const start = Date.now();
                await socket.sendMessage(from, { react: { text: '🏓', key: msg.key } });
                const latency = Date.now() - start;
                await socket.sendMessage(from, { text: `*🏓 PONG!*\n*⏱️ Latency:* ${latency}ms\n*🤖 Bot:* ${config.BOT_NAME}\n*🕒 Time:* ${getSriLankaTimestamp()}` }, { quoted: msg });
            }
            
            // ========== SONG COMMAND ==========
            else if (command === 'song') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide song name!\nExample: .song Dilaw' }, { quoted: msg });
                const query = args.join(' ');
                await socket.sendMessage(from, { react: { text: '🎵', key: msg.key } });
                await socket.sendMessage(from, { text: `🔍 Searching *${query}*...` }, { quoted: msg });
                
                try {
                    const search = await yts(query);
                    const video = search.videos[0];
                    if (!video) return await socket.sendMessage(from, { text: '❌ No results found!' }, { quoted: msg });
                    
                    const apiUrl = `https://api.zenkey.my.id/api/download/ytmp3?url=${encodeURIComponent(video.url)}`;
                    const response = await axios.get(apiUrl);
                    
                    if (response.data && response.data.result) {
                        await socket.sendMessage(from, {
                            audio: { url: response.data.result.download },
                            mimetype: 'audio/mpeg',
                            fileName: `${video.title}.mp3`
                        }, { quoted: msg });
                        await socket.sendMessage(from, { text: `✅ *${video.title}*` }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { text: '❌ Download failed!' }, { quoted: msg });
                    }
                } catch (err) {
                    console.error(err);
                    await socket.sendMessage(from, { text: '❌ Error downloading song!' }, { quoted: msg });
                }
            }
            
            // ========== AI CHAT COMMAND ==========
            else if (command === 'ai' || command === 'gpt') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide a message!\nExample: .ai Hello' }, { quoted: msg });
                const query = args.join(' ');
                await socket.sendMessage(from, { react: { text: '🤖', key: msg.key } });
                await socket.sendMessage(from, { text: '🧠 *AI is thinking...*' }, { quoted: msg });
                
                try {
                    const response = await axios.get(`https://api.ryzendesu.vip/api/ai/gpt4?text=${encodeURIComponent(query)}`);
                    if (response.data && response.data.answer) {
                        await socket.sendMessage(from, { text: `*🤖 AI Response:*\n\n${response.data.answer}` }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { text: '❌ AI not responding!' }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ AI error!' }, { quoted: msg });
                }
            }
            
            // ========== WEATHER COMMAND ==========
            else if (command === 'weather') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide city name!\nExample: .weather Colombo' }, { quoted: msg });
                const city = args.join(' ');
                await socket.sendMessage(from, { react: { text: '🌤️', key: msg.key } });
                
                try {
                    const response = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=2d61a72574c11c4f36173b627f8cb177&units=metric`);
                    const data = response.data;
                    const weatherText = `*🌤️ WEATHER: ${data.name}, ${data.sys.country}*\n\n🌡️ *Temp:* ${data.main.temp}°C\n🤔 *Feels:* ${data.main.feels_like}°C\n💧 *Humidity:* ${data.main.humidity}%\n🌬️ *Wind:* ${data.wind.speed} m/s\n📝 *Condition:* ${data.weather[0].description}`;
                    await socket.sendMessage(from, { text: weatherText }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ City not found!' }, { quoted: msg });
                }
            }
            
            // ========== GOOGLE SEARCH ==========
            else if (command === 'google' || command === 'search') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide search query!' }, { quoted: msg });
                const query = args.join(' ');
                await socket.sendMessage(from, { react: { text: '🔍', key: msg.key } });
                
                try {
                    const response = await axios.get(`https://api.ryzendesu.vip/api/search/google?query=${encodeURIComponent(query)}`);
                    if (response.data && response.data.result && response.data.result.length) {
                        let results = `*🔍 GOOGLE SEARCH: ${query}*\n\n`;
                        for (let i = 0; i < Math.min(5, response.data.result.length); i++) {
                            const res = response.data.result[i];
                            results += `*${i+1}. ${res.title}*\n📝 ${res.snippet}\n🔗 ${res.link}\n\n`;
                        }
                        await socket.sendMessage(from, { text: results }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { text: '❌ No results!' }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ Search failed!' }, { quoted: msg });
                }
            }
            
            // ========== IMAGE SEARCH ==========
            else if (command === 'img' || command === 'image') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide search query!\nExample: .img nature' }, { quoted: msg });
                const query = args.join(' ');
                await socket.sendMessage(from, { react: { text: '🖼️', key: msg.key } });
                
                try {
                    const response = await axios.get(`https://api.ryzendesu.vip/api/search/pinterest?query=${encodeURIComponent(query)}`);
                    if (response.data && response.data.result && response.data.result.length) {
                        const imgUrl = response.data.result[Math.floor(Math.random() * response.data.result.length)];
                        await socket.sendMessage(from, { image: { url: imgUrl }, caption: `🖼️ *${query}*` }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { text: '❌ No images found!' }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ Image search failed!' }, { quoted: msg });
                }
            }
            
            // ========== FONT COMMAND ==========
            else if (command === 'font') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide text!\nExample: .font Hello' }, { quoted: msg });
                const text = args.join(' ');
                
                const fonts = {
                    'Bold': text.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 119743)),
                    'Italic': text.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 119795)),
                    'Bold Italic': text.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 119847)),
                    'Script': text.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 119893)),
                    'Monospace': text.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 120389)),
                    'Doublestruck': text.replace(/[A-Za-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 120123)),
                    'Sans Serif': text.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 120289))
                };
                
                let fontText = '*🎨 Fancy Fonts*\n\n';
                for (const [name, converted] of Object.entries(fonts)) {
                    fontText += `*${name}:*\n${converted}\n\n`;
                }
                await socket.sendMessage(from, { text: fontText }, { quoted: msg });
            }
            
            // ========== TIKTOK COMMAND ==========
            else if (command === 'tiktok' || command === 'tt') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide TikTok URL!' }, { quoted: msg });
                const url = args[0];
                await socket.sendMessage(from, { react: { text: '📥', key: msg.key } });
                await socket.sendMessage(from, { text: '⏳ Downloading TikTok...' }, { quoted: msg });
                
                try {
                    const response = await axios.get(`https://api.ryzendesu.vip/api/download/tiktok?url=${encodeURIComponent(url)}`);
                    if (response.data && response.data.result && response.data.result.video) {
                        await socket.sendMessage(from, { video: { url: response.data.result.video }, caption: `🎵 *TikTok Video*\n📝 ${response.data.result.title || ''}` }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { text: '❌ Download failed!' }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ TikTok download failed!' }, { quoted: msg });
                }
            }
            
            // ========== INSTAGRAM COMMAND ==========
            else if (command === 'instagram' || command === 'ig') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide Instagram URL!' }, { quoted: msg });
                const url = args[0];
                await socket.sendMessage(from, { react: { text: '📥', key: msg.key } });
                await socket.sendMessage(from, { text: '⏳ Downloading Instagram...' }, { quoted: msg });
                
                try {
                    const response = await axios.get(`https://api.ryzendesu.vip/api/download/instagram?url=${encodeURIComponent(url)}`);
                    if (response.data && response.data.result && response.data.result.length) {
                        for (const media of response.data.result) {
                            if (media.type === 'video') {
                                await socket.sendMessage(from, { video: { url: media.url } }, { quoted: msg });
                            } else if (media.type === 'image') {
                                await socket.sendMessage(from, { image: { url: media.url } }, { quoted: msg });
                            }
                        }
                    } else {
                        await socket.sendMessage(from, { text: '❌ Download failed!' }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ Instagram download failed!' }, { quoted: msg });
                }
            }
            
            // ========== FACEBOOK COMMAND ==========
            else if (command === 'facebook' || command === 'fb') {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide Facebook URL!' }, { quoted: msg });
                const url = args[0];
                await socket.sendMessage(from, { react: { text: '📥', key: msg.key } });
                await socket.sendMessage(from, { text: '⏳ Downloading Facebook...' }, { quoted: msg });
                
                try {
                    const response = await axios.get(`https://api.ryzendesu.vip/api/download/facebook?url=${encodeURIComponent(url)}`);
                    if (response.data && response.data.result && response.data.result.hd) {
                        await socket.sendMessage(from, { video: { url: response.data.result.hd }, caption: '📘 Facebook Video' }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { text: '❌ Download failed!' }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ Facebook download failed!' }, { quoted: msg });
                }
            }
            
            // ========== OWNER COMMANDS ==========
            else if (command === 'block' && isOwner) {
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
                if (!mentioned || !mentioned.length) return await socket.sendMessage(from, { text: '❌ Tag someone to block!' }, { quoted: msg });
                try {
                    await socket.updateBlockStatus(mentioned[0], 'block');
                    await socket.sendMessage(from, { text: `✅ Blocked @${mentioned[0].split('@')[0]}`, mentions: [mentioned[0]] }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ Failed to block!' }, { quoted: msg });
                }
            }
            
            else if (command === 'unblock' && isOwner) {
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
                if (!mentioned || !mentioned.length) return await socket.sendMessage(from, { text: '❌ Tag someone to unblock!' }, { quoted: msg });
                try {
                    await socket.updateBlockStatus(mentioned[0], 'unblock');
                    await socket.sendMessage(from, { text: `✅ Unblocked @${mentioned[0].split('@')[0]}`, mentions: [mentioned[0]] }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(from, { text: '❌ Failed to unblock!' }, { quoted: msg });
                }
            }
            
            else if (command === 'broadcast' && isOwner) {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide message to broadcast!' }, { quoted: msg });
                const broadcastMsg = args.join(' ');
                const numbers = getAllNumbersFromLocal();
                let success = 0;
                for (const num of numbers) {
                    try {
                        const sock = activeSockets.get(num);
                        if (sock) {
                            await sock.sendMessage(`${num}@s.whatsapp.net`, { text: `📢 *BROADCAST*\n\n${broadcastMsg}` });
                            success++;
                        }
                    } catch(e) {}
                }
                await socket.sendMessage(from, { text: `✅ Broadcast sent to ${success} sessions!` }, { quoted: msg });
            }
            
            // ========== SETTINGS COMMANDS ==========
            else if (command === 'setname' && isOwner) {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide bot name!' }, { quoted: msg });
                const newName = args.join(' ');
                const userConfig = await loadUserConfigFromLocal(sessionNumber);
                userConfig.botName = newName;
                await setUserConfigInLocal(sessionNumber, userConfig);
                await socket.sendMessage(from, { text: `✅ Bot name changed to: ${newName}` }, { quoted: msg });
            }
            
            else if (command === 'setprefix' && isOwner) {
                if (!args.length) return await socket.sendMessage(from, { text: '❌ Please provide prefix symbol!' }, { quoted: msg });
                const newPrefix = args[0];
                const userConfig = await loadUserConfigFromLocal(sessionNumber);
                userConfig.prefix = newPrefix;
                await setUserConfigInLocal(sessionNumber, userConfig);
                await socket.sendMessage(from, { text: `✅ Prefix changed to: ${newPrefix}` }, { quoted: msg });
            }
            
            // ========== JID COMMAND ==========
            else if (command === 'jid') {
                await socket.sendMessage(from, { text: `🆔 *Your JID:*\n${sender}` }, { quoted: msg });
            }
            
            // ========== SUPPORT/GROUP COMMAND ==========
            else if (command === 'support' || command === 'group') {
                await socket.sendMessage(from, { text: `👥 *Support Group*\n${config.GROUP_INVITE_LINK}` }, { quoted: msg });
            }
            
            // ========== OWNER INFO ==========
            else if (command === 'owner') {
                await socket.sendMessage(from, { text: `👑 *Owner Info*\n📛 Name: ${config.OWNER_NAME}\n📞 Number: ${config.OWNER_NUMBER}` }, { quoted: msg });
            }
            
            // ========== STATS COMMAND ==========
            else if (command === 'stats') {
                const activeCount = activeSockets.size;
                const numbers = getAllNumbersFromLocal();
                await socket.sendMessage(from, { text: `📊 *BOT STATS*\n\n✅ Active Sessions: ${activeCount}\n📝 Total Numbers: ${numbers.length}\n🤖 Bot Name: ${config.BOT_NAME}\n📟 Version: ${config.BOT_VERSION}` }, { quoted: msg });
            }
            
            // ========== DEFAULT ==========
            else {
                await socket.sendMessage(from, { react: { text: '❓', key: msg.key } });
                await socket.sendMessage(from, { text: `❌ Unknown command!\nType *${prefix}menu* for help.` }, { quoted: msg });
            }
            
        } catch (err) {
            console.error('Command error:', err);
            await socket.sendMessage(from, { text: '❌ Error processing command!' }, { quoted: msg });
        }
    });
}

// ========== STATUS HANDLER ==========
async function setupStatusHandlers(socket, sessionNumber) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.key || msg.key.remoteJid !== 'status@broadcast') return;
        
        try {
            const userConfig = await loadUserConfigFromLocal(sessionNumber);
            const autoView = userConfig.autoView !== undefined ? userConfig.autoView : config.AUTO_VIEW_STATUS;
            const autoReact = userConfig.autoReact !== undefined ? userConfig.autoReact : config.AUTO_LIKE_STATUS;
            
            if (autoView === 'true' || autoView === true) {
                await socket.readMessages([msg.key]);
            }
            
            if (autoReact === 'true' || autoReact === true) {
                const emojis = userConfig.reactEmojis || config.AUTO_LIKE_EMOJI;
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                await socket.sendMessage(msg.key.remoteJid, { react: { text: randomEmoji, key: msg.key } }, { statusJidList: [msg.key.participant] });
            }
        } catch (err) {
            console.error('Status handler error:', err);
        }
    });
}

// ========== PAIR FUNCTION ==========
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
    
    try {
        const localDoc = await loadCredsFromLocal(sanitizedNumber);
        if (localDoc && localDoc.creds) {
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(localDoc.creds, null, 2));
            if (localDoc.keys) fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(localDoc.keys, null, 2));
        }
    } catch (e) {}

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'fatal' });

    try {
        const socket = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            logger,
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        socketCreationTime.set(sanitizedNumber, Date.now());
        setupCommandHandlers(socket, sanitizedNumber);
        setupStatusHandlers(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let code;
            let retries = 3;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (err) {
                    retries--;
                    if (retries === 0) throw err;
                    await delay(2000);
                }
            }
            if (!res.headersSent) res.send({ code });
        }

        socket.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                const credsPath = path.join(sessionPath, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    const credsObj = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                    saveCredsToLocal(sanitizedNumber, credsObj, state.keys);
                }
            } catch (err) {
                console.error('Save creds error:', err);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                await delay(2000);
                const welcomeMsg = `✅ *${config.BOT_NAME} Connected!*\n\n📱 Number: ${sanitizedNumber}\n⏰ Time: ${getSriLankaTimestamp()}\n\n📌 Type *${config.PREFIX}menu* for commands!`;
                await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: welcomeMsg });
                addNumberToLocal(sanitizedNumber);
                activeSockets.set(sanitizedNumber, socket);
                console.log(`✅ Connected: ${sanitizedNumber}`);
            }
            if (update.connection === 'close') {
                activeSockets.delete(sanitizedNumber);
                console.log(`❌ Disconnected: ${sanitizedNumber}`);
            }
        });

        activeSockets.set(sanitizedNumber, socket);

    } catch (error) {
        console.error('Pairing error:', error);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}

// ========== ROUTES ==========
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    const sanitized = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitized)) {
        return res.status(200).send({ status: 'already_connected' });
    }
    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.json({ 
        status: 'success', 
        botName: config.BOT_NAME,
        activeSessions: activeSockets.size,
        numbers: Array.from(activeSockets.keys()),
        time: getSriLankaTimestamp()
    });
});

router.get('/ping', (req, res) => {
    res.json({ status: 'active', botName: config.BOT_NAME, activeSessions: activeSockets.size });
});

router.get('/reconnect', async (req, res) => {
    const numbers = getAllNumbersFromLocal();
    const results = [];
    for (const number of numbers) {
        if (activeSockets.has(number)) {
            results.push({ number, status: 'already_connected' });
            continue;
        }
        const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
        await EmpirePair(number, mockRes);
        results.push({ number, status: 'initiated' });
        await delay(1000);
    }
    res.json({ status: 'success', results });
});

module.exports = router;
