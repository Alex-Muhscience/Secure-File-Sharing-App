# 🚀 **Hybrid Blockchain-Based Secure File Transfer System**

> **A Decentralized, Scalable, and Secure File Transfer Solution**

🔐 **Ensuring End-to-End Security for File Transfers**

This system enables secure file transfers using hybrid blockchain architecture. It encrypts files using **AES-256**, stores metadata (**hash, permissions**) on **Ethereum smart contracts**, and saves encrypted files in **IPFS/AWS S3**.

---

## 🌟 **Features**

✔️ **End-to-End Security**: Files are AES-256 encrypted before storage 🔒  
✔️ **Blockchain-Based Access Control**: Only authorized users can access files 📜  
✔️ **Decentralized Identity (DID)**: Secure authentication with Web3 login 💻  
✔️ **Tamper-Proof Metadata**: File hashes & timestamps stored on-chain 🛡  
✔️ **Hybrid Storage**: Metadata on blockchain, encrypted files in IPFS, AWS S3, or private storage 📂  
✔️ **User-Friendly Web UI**: Upload, retrieve, and manage files easily 🖥️  
✔️ **Smart Contracts for Verification**: Prevent unauthorized file access 🚀  
✔️ **Audit Logging & Tracking**: Ensures accountability and tracking 📊  

---

## 🏗️ **System Architecture**

### 🔹 **1. User Authentication & Access Control**
🔑 **Decentralized Identity** (DID/Web3 login) for secure authentication  
🛡 **Role-based access control (RBAC)** managed via smart contracts  

### 🔹 **2. File Upload & Encryption**
🔒 **Files are encrypted** using AES-256 before upload  
📜 **Smart contract stores metadata** (file hash, permissions, timestamps)  
📁 **Encrypted file stored** in IPFS, AWS S3, or private cloud  

### 🔹 **3. Blockchain Layer (Ethereum Smart Contracts)**
📜 **Smart contracts enforce file ownership & access control**  
⏳ **Tamper-proof metadata stored on-chain for auditing**  

### 🔹 **4. Off-Chain Storage (IPFS / AWS S3 / Private Storage)**
📁 **Encrypted files stored securely off-chain**  
🔄 **File access verified via blockchain before retrieval**  

### 🔹 **5. File Retrieval & Decryption**
✅ **Smart contract verifies user access rights**  
🔑 **User retrieves & decrypts the file locally**  

---

## 📂 **Project Structure**
```
secure-file-transfer/
├── frontend/         # React.js frontend (Web3 integration)
│   ├── index.html    # UI for file upload & retrieval
│   ├── styles.css    # CSS styles
│   ├── app.js        # Frontend logic (Web3, IPFS, API)
├── backend/          # Node.js API for IPFS & blockchain
│   ├── server.js     # Backend API
│   ├── config.js     # API configuration
│   ├── routes/       # API routes for file handling
│   ├── storage/      # Encrypted file storage (local backup)
├── contracts/        # Solidity smart contracts
│   ├── FileRegistry.sol  # Smart contract for metadata storage
│   ├── AccessControl.sol # Smart contract for access control
│   ├── migrations/   # Deployment scripts
├── blockchain/       # Hardhat scripts for blockchain deployment
│   ├── deploy.js     # Smart contract deployment script
│   ├── test/         # Unit tests for contracts
├── .env              # Environment variables
├── Dockerfile        # Dockerfile for containerization
├── docker-compose.yml # Docker Compose setup for IPFS & MongoDB
└── README.md         # Project documentation
```

---

## 🛠️ **Requirements**
✅ Node.js (v16 or later)  
✅ Docker & Docker Compose  
✅ IPFS Node or AWS S3 Bucket  
✅ Ethereum Testnet (Goerli, Sepolia, or local Hardhat)  
✅ MetaMask or Web3 Wallet  

---

## 🚀 **Getting Started**

### 1️⃣ **Clone the Repository**
```bash
git clone https://github.com/your-username/secure-file-transfer.git
cd secure-file-transfer
```

### 2️⃣ **Install Dependencies**
```bash
npm install
```

### 3️⃣ **Set Up Environment Variables**
Create a `.env` file in the root directory and define:
```plaintext
PORT=3000
MONGO_URI=mongodb://127.0.0.1:27017/secure-file-transfer
INFURA_API_KEY=your-infura-api-key
ETHEREUM_NETWORK=goerli
PRIVATE_KEY=your-private-key
IPFS_API_URL=https://ipfs.infura.io:5001
JWT_SECRET=your-jwt-secret
```

### 4️⃣ **Deploy Smart Contracts**
#### Run on a local blockchain:
```bash
npx hardhat node
npx hardhat run scripts/deploy.js --network localhost
```
#### Deploy to Ethereum Testnet:
```bash
npx hardhat run scripts/deploy.js --network goerli
```

### 5️⃣ **Start the Backend API**
```bash
node backend/server.js
```

### 6️⃣ **Start the Frontend**
```bash
cd frontend
npm start
```
🖥 **Visit** [http://localhost:3000](http://localhost:3000) **to access the UI.**

---

## 📝 **Usage**

### 🔹 **Upload a File**
1. Open the web interface at [http://localhost:3000](http://localhost:3000)
2. Select and upload a file
3. File is AES-256 encrypted
4. Encrypted file is stored in IPFS/S3, metadata on Ethereum
5. File hash & owner details saved on-chain

### 🔹 **Verify & Download File**
1. User requests file access
2. Smart contract verifies ownership & access rights
3. If authorized, IPFS/S3 link is shared
4. User downloads and decrypts file locally

---

## 📜 **Scripts**

🔹 **Start Backend API**  
```bash
npm start
```

🔹 **Run in Development Mode (nodemon)**  
```bash
npm run dev
```

🔹 **Deploy Smart Contracts**  
```bash
npx hardhat run scripts/deploy.js --network goerli
```

---

## 🐳 **Docker Support**

### Build and Run Containers
```bash
docker-compose up --build
```

### Stop Containers
```bash
docker-compose down
```

---

## ☁️ **Kubernetes Deployment**

### Deploy with Kubernetes
```bash
kubectl apply -f Deployment.yaml
kubectl expose deployment secure-file-transfer --type=LoadBalancer --port=3000 --target-port=3000
kubectl get services
```

---

## 🖥️ **Technologies Used**
🔹 **Node.js & Express.js** - Backend API  
🔹 **Ethereum Smart Contracts** - Solidity, Hardhat  
🔹 **IPFS & AWS S3** - Off-chain storage  
🔹 **React.js** - Frontend  
🔹 **Web3.js & MetaMask** - Decentralized Authentication  
🔹 **AES-256 Encryption** - Secure file storage  
🔹 **MongoDB** - File metadata storage  
🔹 **Docker & Kubernetes** - Containerization & orchestration  

---

## 🤝 **Contributing**
🔹 Fork the repo  
🔹 Create a new branch: `feature/new-feature`  
🔹 Submit a Pull Request  

---

## 📜 **License**
MIT License - See [LICENSE](LICENSE) for details.

---

## 📧 **Contact**
📧 **Alex Murimi Kamau** - alexkamau712@gmail.com  
🌐 **GitHub** - [Alex-Muhscience](https://github.com/Alex-Muhscience)  

🚀 **"Secure. Decentralized. Efficient."** 🔐
