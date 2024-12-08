require("dotenv").config();
const express = require("express");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validate ENCRYPTION_KEY
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  throw new Error(
    "Invalid ENCRYPTION_KEY. Ensure it is a 64-character hex string in the .env file."
  );
}

const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
const IV_LENGTH = 16;

// Multer storage for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// Middleware for token verification
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token)
    return res.status(401).json({ success: false, message: "Unauthorized" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) {
    res
      .status(403)
      .json({ success: false, message: "Invalid or expired token" });
  }
};

// Encryption utility
const encryptFile = (filePath) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);

  const input = fs.createReadStream(filePath);
  const output = fs.createWriteStream(`${filePath}.enc`);

  input.pipe(cipher).pipe(output);
  return { encryptedFilePath: `${filePath}.enc`, iv: iv.toString("hex") };
};

// Decryption utility
const decryptFile = (encryptedFilePath, iv) => {
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    ENCRYPTION_KEY,
    Buffer.from(iv, "hex")
  );
  const decryptedFilePath = encryptedFilePath.replace(".enc", "");
  const input = fs.createReadStream(encryptedFilePath);
  const output = fs.createWriteStream(decryptedFilePath);

  input.pipe(decipher).pipe(output);
  return decryptedFilePath;
};

// Route to request OTP
app.post("/request-otp", (req, res) => {
  const { email } = req.body;
  if (!email)
    return res
      .status(400)
      .json({ success: false, message: "Email is required" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  console.log(`OTP for ${email}: ${otp}`); // Mocked OTP sending

  const token = jwt.sign({ email, otp }, process.env.JWT_SECRET, {
    expiresIn: "30m",
  }); // Token valid for 30 minutes
  res.json({ success: true, token, expiresIn: "30 minutes" });
});

// Route to upload and encrypt file
app.post("/upload", upload.single("file"), verifyToken, (req, res) => {
  const { file } = req;
  const { email } = req.body;

  if (!email || !file) {
    return res
      .status(400)
      .json({ success: false, message: "Missing email or file" });
  }

  const { iv, encryptedFilePath } = encryptFile(file.path);

  fs.unlink(file.path, (err) => {
    if (err) console.error("Error deleting original file:", err);
  });

  res.json({ success: true, encryptedFilePath, iv });
});

// Route to download and decrypt file
app.get("/download", verifyToken, (req, res) => {
  const { encryptedFilePath, iv } = req.query;
  if (!encryptedFilePath || !iv) {
    return res
      .status(400)
      .json({ success: false, message: "Missing parameters" });
  }

  if (!fs.existsSync(encryptedFilePath)) {
    return res.status(404).json({ success: false, message: "File not found" });
  }

  try {
    const decryptedFilePath = decryptFile(encryptedFilePath, iv);
    res.download(decryptedFilePath, () => {
      fs.unlink(decryptedFilePath, (err) => {
        if (err) console.error("Error deleting decrypted file:", err);
      });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Decryption failed" });
  }
});

// Cleanup encrypted files every 1.5 hours
const cleanupEncryptedFiles = () => {
  fs.readdir("uploads", (err, files) => {
    if (err) throw err;

    for (const file of files) {
      if (file.endsWith(".enc")) {
        fs.unlink(path.join("uploads", file), (err) => {
          if (err) console.error("Error deleting file:", err);
        });
      }
    }
  });
};
setInterval(cleanupEncryptedFiles, 1800000); // 1.5 hours

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});