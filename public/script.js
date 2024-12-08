const uploadButton = document.getElementById("uploadButton");
const otpField = document.getElementById("otpField");
const fileInput = document.getElementById("fileInput");
const emailInput = document.getElementById("emailInput");
const otpInput = document.getElementById("otpInput");
const verifyOtpButton = document.getElementById("verifyOtpButton");

let uploadedFileMetadata = null; // To store file metadata

uploadButton.addEventListener("click", async () => {
  const email = emailInput.value;
  if (!email || fileInput.files.length === 0) {
    alert("Please provide an email and select a file.");
    return;
  }

  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append("file", file);
  formData.append("email", email);

  const response = await fetch("/upload", {
    method: "POST",
    body: formData,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("token")}`,
    },
  });

  const data = await response.json();
  if (data.success) {
    uploadedFileMetadata = data; // Save metadata for later
    otpField.style.display = "block";
    alert("File uploaded successfully! Enter the OTP sent to your email.");
  } else {
    alert("File upload failed.");
  }
});

verifyOtpButton.addEventListener("click", async () => {
  const otp = otpInput.value.trim();

  if (!otp || !uploadedFileMetadata) {
    alert("Missing OTP or file details.");
    return;
  }

  const { encryptedFilePath, iv } = uploadedFileMetadata;

  const response = await fetch(
    `/download?encryptedFilePath=${encryptedFilePath}&iv=${iv}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${otp}` },
    }
  );

  const crypto = require("crypto");
console.log(crypto.randomBytes(32).toString("hex")); // Generates a 64-character hex string

  if (response.status === 200) {
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "file";
    a.click();
  } else {
    alert("Invalid OTP or file download failed.");
  }
});