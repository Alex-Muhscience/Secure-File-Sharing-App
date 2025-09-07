require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

// Configuration and utilities
const config = require('./config');
const logger = require('./utils/logger');

// Services
const StorageService = require('./services/StorageService');
const FileService = require('./services/FileService');

// Middleware
const { securityHeaders, errorHandler } = require('./middleware/auth');

// Routes
const apiRoutes = require('./routes/api');

const app = express();

// MongoDB connection
mongoose.connect(config.getDatabaseUrl(), config.database.options)
  .then(() => {
    logger.info('Connected to MongoDB', {
      database: config.database.uri.split('/').pop(),
      environment: config.server.env
    });
  })
  .catch((error) => {
    logger.error('MongoDB connection failed', error);
    process.exit(1);
  });

// MongoDB connection event handlers
mongoose.connection.on('error', (error) => {
  logger.error('MongoDB connection error', error);
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB reconnected');
});

// Trust proxy if configured
if (config.production.trustProxy) {
  app.set('trust proxy', 1);
}

// Security headers
app.use(securityHeaders);

// CORS configuration
app.use(require('cors')({
  origin: config.server.cors.origins,
  credentials: config.server.cors.credentials
}));

// Rate limiting
app.use(require('express-rate-limit')({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { success: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/api/health';
  }
}));

// Body parsing middleware
app.use(express.json({ 
  limit: config.file.maxSize,
  verify: (req, res, buf) => {
    // Log large payloads
    if (buf.length > 10 * 1024 * 1024) { // 10MB
      logger.warn('Large JSON payload received', {
        size: buf.length,
        ip: req.ip,
        path: req.path
      });
    }
  }
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: config.file.maxSize 
}));

// Static file serving
app.use(express.static('public'));

// API Routes
app.use('/api', apiRoutes);

// Health check endpoint (also available at root level)
app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: require('./package.json').version || '1.0.0',
      environment: config.server.env
    };

    // Check database connection
    if (mongoose.connection.readyState === 1) {
      health.database = 'connected';
    } else {
      health.database = 'disconnected';
      health.status = 'degraded';
    }

    // Check storage
    try {
      const storageStats = await StorageService.getStorageStats();
      health.storage = {
        usage: storageStats.total.usagePercentage,
        status: storageStats.total.usagePercentage > 90 ? 'warning' : 'ok'
      };
    } catch (error) {
      health.storage = { status: 'error' };
    }

    const statusCode = health.status === 'healthy' ? 200 : 
                      health.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(health);

  } catch (error) {
    logger.error('Health check failed', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Error handling middleware (must be last)
app.use(errorHandler);

// Cleanup expired files periodically
setInterval(async () => {
  try {
    await FileService.cleanupExpiredFiles();
  } catch (error) {
    logger.error('Scheduled cleanup failed', error);
  }
}, config.file.cleanupInterval);

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (error) {
    logger.error('Error closing MongoDB connection', error);
  }
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (error) {
    logger.error('Error closing MongoDB connection', error);
  }
  
  process.exit(0);
});

// Start server
const PORT = config.server.port;
app.listen(PORT, config.server.host, () => {
  logger.info(`Server started successfully`, {
    port: PORT,
    host: config.server.host,
    environment: config.server.env,
    nodeVersion: process.version,
    pid: process.pid
  });
  
  console.log(`🚀 Server running on http://${config.server.host}:${PORT}`);
  console.log(`📊 Health check: http://${config.server.host}:${PORT}/health`);
  console.log(`🔧 Environment: ${config.server.env}`);
});