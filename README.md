# 🚀 Secure File Sharing Platform

Welcome to the **Secure File Sharing Platform**! This robust web application ensures your files remain safe and secure during transfer. Built with Node.js, this system encrypts files during upload and decrypts them during download, maintaining confidentiality. It supports Docker for containerization and integrates seamlessly with MongoDB for efficient and scalable deployment.

---

## 🌟 Features

- 🔒 **File Encryption and Decryption**: Secure your files with AES-256 encryption.
- 📜 **Audit Logs**: Track and log all system activities.
- 💻 **User-Friendly Interface**: Simple UI for uploading and downloading files.
- ⚙️ **Environment Configuration**: Supports environment-based configurations with `.env`.
- 🐳 **Docker Containerization**: Easy deployment with Docker and Docker Compose.
- 🗄️ **MongoDB Integration**: Efficient database management for file metadata.

---

## 📂 Project Structure

```plaintext
secure-file-sharing/
├── app.js              # Main server file
├── public/             # Front-end files
│   ├── index.html      # Front-end HTML
│   ├── styles.css      # Optional CSS
│   └── script.js       # Front-end JavaScript
├── uploads/            # Folder to store encrypted files
├── downloads/          # Temporary folder for decrypted downloads
├── logs/               # Folder for audit logs
├── .env                # Environment variables
├── Dockerfile          # Dockerfile for containerization
├── docker-compose.yml  # Docker Compose for MongoDB integration
├── package.json        # Node.js dependencies
└── package-lock.json   # Node.js lock file
```

---

## 🛠️ Requirements

- **Node.js** (v16 or later)
- **Docker**
- **Docker Compose**
- **MongoDB** (if running without Docker Compose)

---

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/secure-file-sharing.git
cd secure-file-sharing
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Environment Variables

Create a `.env` file in the root directory and define the following variables:

```plaintext
PORT=3000
MONGO_URI=mongodb://localhost:27017/secure-file-sharing
SECRET_KEY=your-encryption-key
```

### 4. Run the Application

#### Without Docker

```bash
node app.js
```

Access the application at `http://localhost:3000`.

#### With Docker

Build and run the container:

```bash
docker-compose up --build
```

Access the application at `http://localhost:3000`.

---

## 📝 Usage

1. Open the web interface at `http://localhost:3000`.
2. Upload a file to encrypt it.
3. Download the encrypted file, which will be decrypted automatically.

---

## 📁 Folder Descriptions

- **`uploads/`**: Stores encrypted files securely.
- **`downloads/`**: Temporarily holds decrypted files for downloads.
- **`logs/`**: Contains system audit logs for tracking activities.
- **`public/`**: Front-end files including HTML, CSS, and JavaScript.

---

## 📜 Scripts

- **Start Server**: `npm start`
- **Run in Development Mode**: `npm run dev` (requires `nodemon`)

---

## 🐳 Docker Support

- **Build the Docker image manually**:

  ```bash
  docker build -t secure-file-sharing .
  ```

- **Run the container**:

  ```bash
  docker run -p 3000:3000 secure-file-sharing
  ```

- **Stop containers**:

  ```bash
  docker-compose down
  ```

---

## 🖥️ Technologies Used

- **Node.js**: Backend runtime.
- **Express.js**: Server framework.
- **MongoDB**: Database for file metadata.
- **Crypto**: Built-in module for encryption/decryption.
- **Docker**: Containerization.

---

## 🤝 Contributing

1. Fork the repository.
2. Create a new branch.
3. Make changes and test thoroughly.
4. Submit a pull request.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).

---

## 🙏 Acknowledgments

- Node.js and Express.js for making development seamless.
- MongoDB for efficient data handling.
- Docker for easy deployment and scalability.

---
