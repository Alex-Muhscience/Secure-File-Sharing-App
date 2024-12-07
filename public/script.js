const uploadButton = document.getElementById("uploadButton");
const otpField = document.getElementById("otpField");
const fileInput = document.getElementById("fileInput");
const emailInput = document.getElementById("emailInput");
const otpInput = document.getElementById("otpInput");
const verifyOtpButton = document.getElementById("verifyOtpButton");

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
  });

  const data = await response.json();
  if (data.success) {
    otpField.style.display = "block";
    alert("File uploaded successfully! Enter the OTP sent to your email.");
  } else {
    alert("File upload failed.");
  }
});

verifyOtpButton.addEventListener("click", async () => {
  const otp = otpInput.value.trim();

  if (!otp) {
    alert("Please enter the OTP.");
    return;
  }

  const response = await fetch("/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ otp }),
  });

  if (response.status === 200) {
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "file";
    a.click();
  } else {
    alert("Invalid OTP.");
  }
});

const cleanupUploadsFolder = () => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) throw err;

    for (const file of files) {
      fs.unlink(path.join(uploadDir, file), (err) => {
        if (err) throw err;
      });
    }
  });
};

// Set an interval to clean up the uploads folder every hour
setInterval(cleanupUploadsFolder, 1800000); // Every 1800000 ms = 1.5 hour
