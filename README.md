# 🚀 Secure File Sharing Platform

Welcome to the **Secure File Sharing Platform**! This web application ensures your files are securely encrypted and decrypted during transfers. Built with Node.js, the platform supports Docker containerization and integrates seamlessly with MongoDB for efficient deployment and scalability.

---

## 🌟 Features

- 🔒 **File Encryption & Decryption**: Ensures secure file uploads and downloads using AES-256 encryption.
- 📜 **Audit Logs**: Tracks and logs all system activities for accountability.
- 💻 **User-Friendly Interface**: Simple and intuitive UI for uploading and downloading files.
- ⚙️ **Environment Configuration**: Supports environment-based configurations with `.env` files.
- 🐳 **Docker Support**: Easy deployment using Docker and Docker Compose.
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
├── uploads/            # Directory to store encrypted files
├── downloads/          # Temporary folder for decrypted downloads
├── logs/               # Folder for audit logs
├── .env                # Environment variables configuration
├── Dockerfile          # Dockerfile for containerization
├── docker-compose.yml  # Docker Compose configuration for MongoDB integration
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
MONGO_URI=mongodb://127.0.0.1:27017/secure-file-sharing
JWT_SECRET=your-jwt-secret
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

1. **Upload a File**:
   - Open the web interface at `http://localhost:3000`.
   - Upload a file to encrypt it.
   - The file will be encrypted and stored securely.

2. **Verify OTP and Download File**:
   - Enter the OTP received via email to download the encrypted file.
   - The file will be decrypted automatically.

---

## 📁 Folder Descriptions

- **`uploads/`**: Stores encrypted files securely.
- **`downloads/`**: Temporarily holds decrypted files for download.
- **`logs/`**: Contains system audit logs for tracking activities.
- **`public/`**: Front-end files including HTML, CSS, and JavaScript.

---

## 📜 Scripts

- **Start Server**: `npm start`
- **Run in Development Mode**: `npm run dev` (requires `nodemon`)

---

## 🐳 Docker Support

### Building and Pushing Docker Image

1. **Build the Docker Image**:

    ```bash
    docker build -t your-docker-image:latest .
    ```

2. **Log in to Docker Hub (or your chosen registry)**:

    ```bash
    docker login
    ```

3. **Push the Docker Image**:

    ```bash
    docker push your-docker-image:latest
    ```

### Running with Docker Compose

1. **Build and Run Containers**:

    ```bash
    docker-compose up --build
    ```

2. **Stop Containers**:

    ```bash
    docker-compose down
    ```

### Kubernetes Deployment

1. **Update Deployment YAML**:
   Ensure your `Deployment.yaml` file includes resource limits.

    ```yaml
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: secure-file-sharing
    spec:
      replicas: 3
      selector:
        matchLabels:
          app: secure-file-sharing
      template:
        metadata:
          labels:
            app: secure-file-sharing
        spec:
          containers:
            - name: app
              image: your-docker-image:latest
              ports:
                - containerPort: 3000
              env:
                - name: MONGO_URI
                  value: "mongodb://127.0.0.1:27017/secure-file-sharing"
                - name: JWT_SECRET
                  value: "your-jwt-secret"
              resources:
                limits:
                  memory: "512Mi"
                  cpu: "500m"
                requests:
                  memory: "256Mi"
                  cpu: "250m"
    ```

2. **Apply the Deployment**:

    ```bash
    kubectl apply -f Deployment.yaml
    ```

3. **Expose the Deployment**:

    ```bash
    kubectl expose deployment secure-file-sharing --type=LoadBalancer --port=3000 --target-port=3000
    ```

4. **Get Service Details**:

    ```bash
    kubectl get services
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

- Node.js and Express.js for seamless development.
- MongoDB for efficient data handling.
- Docker for easy deployment and scalability.

---
