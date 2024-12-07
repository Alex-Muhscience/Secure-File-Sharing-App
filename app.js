require("dotenv").config();
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static("public"));

// MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
});

const otpSchema = new mongoose.Schema({
  email: String,
  otp: String,
  filePath: String,
  iv: String,
  createdAt: { type: Date, default: Date.now, expires: 300 }, // TTL: 5 mins
});

const auditLogSchema = new mongoose.Schema({
  action: String, // "upload" or "download"
  userId: mongoose.Schema.Types.ObjectId,
  fileName: String,
  timestamp: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);
const OTP = mongoose.model("OTP", otpSchema);
const AuditLog = mongoose.model("AuditLog", auditLogSchema);

// AES-256 Encryption
const ENCRYPTION_KEY = crypto.randomBytes(32); // 32 bytes for AES-256
const IV_LENGTH = 16; // Initialization vector length

function encryptFile(filePath) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  const input = fs.createReadStream(filePath);
  const output = fs.createWriteStream(`${filePath}.enc`);

  input.pipe(cipher).pipe(output);
  return { iv: iv.toString("hex"), encryptedFilePath: `${filePath}.enc` };
}

function decryptFile(encryptedFilePath, iv) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, Buffer.from(iv, "hex"));
  const input = fs.createReadStream(encryptedFilePath);
  const output = fs.createWriteStream(encryptedFilePath.replace(".enc", ""));
  input.pipe(decipher).pipe(output);

  return encryptedFilePath.replace(".enc", ""); // Return decrypted file path
}

// User Registration
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    const newUser = new User({ email, password: hashedPassword });
    await newUser.save();
    res.send({ success: true, message: "User registered successfully." });
  } catch (err) {
    res.status(400).send({ success: false, message: "User registration failed." });
  }
});

// User Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(400).send({ success: false, message: "Invalid email or password." });

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) return res.status(400).send({ success: false, message: "Invalid email or password." });

  // Generate JWT
  const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });

  res.send({ success: true, token });
});

// Middleware to Authenticate Token
function authenticateToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(401).send({ success: false, message: "Access denied." });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).send({ success: false, message: "Invalid token." });
    req.user = user;
    next();
  });
}

// File Upload
app.post("/upload", authenticateToken, upload.single("file"), async (req, res) => {
  const userId = req.user.userId;
  const filePath = req.file.path;
  const { iv, encryptedFilePath } = encryptFile(filePath);

  fs.unlinkSync(filePath); // Remove original file to save space

  // Generate OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
  const newOtp = new OTP({
    email: req.body.email,
    otp,
    filePath: encryptedFilePath,
    iv,
  });

  await newOtp.save();

  // Log the upload
  const log = new AuditLog({ action: "upload", userId, fileName: req.file.originalname });
  await log.save();

  res.send({ success: true, message: "File uploaded successfully. OTP sent to email." });
});

// Verify OTP and Download File
app.post("/verify-otp", authenticateToken, async (req, res) => {
  const { otp } = req.body;

  const otpRecord = await OTP.findOne({ otp });
  if (!otpRecord) {
    return res.status(400).send({ success: false, message: "Invalid or expired OTP." });
  }

  const decryptedFilePath = decryptFile(otpRecord.filePath, otpRecord.iv);

  res.download(decryptedFilePath, path.basename(decryptedFilePath), (err) => {
    if (err) {
      console.error("Error sending file:", err);
    } else {
      // Cleanup decrypted file and log download
      fs.unlinkSync(decryptedFilePath);
      const log = new AuditLog({ action: "download", userId: req.user.userId, fileName: otpRecord.filePath });
      log.save();
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});