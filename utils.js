const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Encrypt file
function encryptFile(filePath) {
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(process.env.SECRET_KEY, 'hex');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

    const input = fs.createReadStream(filePath);
    const encryptedFilePath = path.join('uploads', `${Date.now()}-${path.basename(filePath)}.enc`);
    const output = fs.createWriteStream(encryptedFilePath);

    input.pipe(cipher).pipe(output);
    return { encryptedFilePath, iv: iv.toString('hex') };
}

// Decrypt file
function decryptFile(encryptedFilePath, iv) {
    const key = Buffer.from(process.env.SECRET_KEY, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));

    const input = fs.createReadStream(encryptedFilePath);
    const decryptedFilePath = path.join('downloads', path.basename(encryptedFilePath, '.enc'));
    const output = fs.createWriteStream(decryptedFilePath);

    input.pipe(decipher).pipe(output);
    return decryptedFilePath;
}

// Log action
function logAction(message) {
    const logFile = path.join('logs', 'audit.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
}

module.exports = { encryptFile, decryptFile, logAction };
