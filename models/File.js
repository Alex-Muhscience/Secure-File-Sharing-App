const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
    originalName: { type: String, required: true },
    encryptedName: { type: String, required: true },
    iv: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('File', fileSchema);
