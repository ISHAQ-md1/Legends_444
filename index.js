const express = require('express');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pairRouter = require('./pair');

app.use('/code', pairRouter);
app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html'));
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════╗
║   🤖 ALONE MINI BOT DEPLOYED 🤖    ║
╠════════════════════════════════════╣
║   PORT: ${PORT}                       ║
║   STATUS: RUNNING ✅                 ║
║   TIME: ${new Date().toLocaleString()}   ║
╚════════════════════════════════════╝
    `);
});

module.exports = app;
