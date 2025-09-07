const uploadButton = document.getElementById("uploadButton");
const otpField = document.getElementById("otpField");
const fileInput = document.getElementById("fileInput");
const emailInput = document.getElementById("emailInput");
const otpInput = document.getElementById("otpInput");
const verifyOtpButton = document.getElementById("verifyOtpButton");
const statusMessage = document.getElementById("statusMessage");
const fileInfo = document.getElementById("fileInfo");
const uploadButtonText = document.getElementById("uploadButtonText");
const uploadButtonLoader = document.getElementById("uploadButtonLoader");
const verifyButtonText = document.getElementById("verifyButtonText");
const verifyButtonLoader = document.getElementById("verifyButtonLoader");

let uploadedFileMetadata = null;
let currentToken = null;
let currentSessionId = null;

// Show status message
function showStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${isError ? 'status-error' : 'status-success'}`;
  statusMessage.style.display = 'block';
  setTimeout(() => {
    statusMessage.style.display = 'none';
  }, 5000);
}

// Show file info
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    const sizeInMB = (file.size / (1024 * 1024)).toFixed(2);
    fileInfo.innerHTML = `
      <p><strong>File:</strong> ${file.name}</p>
      <p><strong>Size:</strong> ${sizeInMB} MB</p>
      <p><strong>Type:</strong> ${file.type || 'Unknown'}</p>
    `;
    fileInfo.style.display = 'block';
  } else {
    fileInfo.style.display = 'none';
  }
});

// Request OTP first
uploadButton.addEventListener("click", async () => {
  const email = emailInput.value;
  if (!email || fileInput.files.length === 0) {
    showStatus("Please provide an email and select a file.", true);
    return;
  }

  // Show loading state
  uploadButtonText.style.display = 'none';
  uploadButtonLoader.style.display = 'inline-block';
  uploadButton.disabled = true;

  try {
    const otpResponse = await fetch("/api/request-otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ 
        email, 
        purpose: "file_upload" 
      }),
    });

    const otpData = await otpResponse.json();
    if (!otpData.success) {
      showStatus(otpData.error || "Failed to send OTP. Please try again.", true);
      return;
    }

    currentSessionId = otpData.sessionId;
    showStatus(`OTP sent to ${email}! Please check your email and enter the OTP below.`);
    otpField.style.display = "block";
    uploadButtonText.textContent = "OTP Sent - Enter OTP Below";

  } catch (error) {
    console.error("Error requesting OTP:", error);
    showStatus("Failed to send OTP. Please try again.", true);
  } finally {
    // Reset button state
    uploadButtonText.style.display = 'inline';
    uploadButtonLoader.style.display = 'none';
    uploadButton.disabled = false;
  }
});

verifyOtpButton.addEventListener("click", async () => {
  const otp = otpInput.value.trim();
  const email = emailInput.value;

  if (!otp || !currentSessionId) {
    showStatus("Please enter the OTP.", true);
    return;
  }

  if (fileInput.files.length === 0) {
    showStatus("Please select a file.", true);
    return;
  }

  // Show loading state
  verifyButtonText.style.display = 'none';
  verifyButtonLoader.style.display = 'inline-block';
  verifyOtpButton.disabled = true;

  try {
    // First verify OTP and get JWT token
    const verifyResponse = await fetch("/api/verify-otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        otp,
        sessionId: currentSessionId
      }),
    });

    const verifyData = await verifyResponse.json();
    if (!verifyData.success) {
      showStatus(verifyData.error || "Invalid OTP. Please try again.", true);
      return;
    }

    currentToken = verifyData.token;
    showStatus("OTP verified! Uploading file...");

    // Now upload file with JWT token
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append("file", file);
    formData.append("email", email);

    const uploadResponse = await fetch("/api/upload", {
      method: "POST",
      body: formData,
      headers: {
        Authorization: `Bearer ${currentToken}`,
      },
    });

    const uploadData = await uploadResponse.json();
    if (uploadData.success) {
      uploadedFileMetadata = uploadData;
      showStatus("File uploaded and encrypted successfully! Starting download...");
      
      // Automatically trigger download
      const downloadResponse = await fetch("/api/download", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify({
          fileId: uploadData.fileId,
          email: email
        }),
      });

      if (downloadResponse.status === 200) {
        const blob = await downloadResponse.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showStatus("File processed and downloaded successfully! 🎉");
        resetForm();
      } else {
        const errorData = await downloadResponse.json();
        showStatus(`Download failed: ${errorData.error}`, true);
      }
    } else {
      showStatus(`Upload failed: ${uploadData.error}`, true);
    }
  } catch (error) {
    console.error("Error during upload/download:", error);
    showStatus("An error occurred. Please try again.", true);
  } finally {
    // Reset button state
    verifyButtonText.style.display = 'inline';
    verifyButtonLoader.style.display = 'none';
    verifyOtpButton.disabled = false;
  }
});

// Auto-format OTP input
otpInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').substring(0, 6);
});

function resetForm() {
  emailInput.value = "";
  fileInput.value = "";
  otpInput.value = "";
  otpField.style.display = "none";
  fileInfo.style.display = "none";
  uploadButtonText.textContent = "🚀 Request OTP & Upload";
  uploadButton.disabled = false;
  uploadedFileMetadata = null;
  currentToken = null;
  currentSessionId = null;
}
