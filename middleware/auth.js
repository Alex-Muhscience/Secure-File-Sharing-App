const jwt = require('jsonwebtoken');
const AuthService = require('../services/AuthService');
const ValidationService = require('../services/ValidationService');
const AuditLog = require('../models/AuditLog');

/**
 * JWT Authentication Middleware
 */
const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    const token = authHeader.substring(7);
    
    // Validate JWT format
    const formatValidation = ValidationService.validateJWTFormat(token);
    if (!formatValidation.isValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token format'
      });
    }

    // Verify and decode token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if session is still valid
    const session = await AuthService.validateSession(decoded.sessionId);
    if (!session.isValid) {
      await AuditLog.logAction('AUTH_FAILURE', {
        level: 'WARN',
        details: {
          reason: 'Invalid session',
          sessionId: decoded.sessionId,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        },
        severity: 6
      });

      return res.status(401).json({
        success: false,
        error: 'Session expired or invalid'
      });
    }

    // Add session and user info to request
    req.session = session.session;
    req.user = {
      email: decoded.email,
      sessionId: decoded.sessionId
    };

    next();

  } catch (error) {
    await AuditLog.logAction('AUTH_ERROR', {
      level: 'ERROR',
      details: {
        error: error.message,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      },
      severity: 7
    });

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Authentication error'
    });
  }
};

/**
 * OTP Verification Middleware
 */
const verifyOTP = async (req, res, next) => {
  try {
    const { otp, sessionId } = req.body;

    // Validate inputs
    const otpValidation = ValidationService.validateOTP(otp);
    if (!otpValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: otpValidation.errors[0]
      });
    }

    const sessionValidation = ValidationService.validateSessionId(sessionId);
    if (!sessionValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: sessionValidation.errors[0]
      });
    }

    // Verify OTP
    const verification = await AuthService.verifyOTP(sessionId, otp, {
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });

    if (!verification.success) {
      return res.status(401).json({
        success: false,
        error: verification.error
      });
    }

    // Add verification result to request
    req.otpVerification = verification;
    req.sessionId = sessionId;

    next();

  } catch (error) {
    await AuditLog.logAction('OTP_VERIFICATION_ERROR', {
      level: 'ERROR',
      details: {
        error: error.message,
        sessionId: req.body.sessionId,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      },
      severity: 7
    });

    return res.status(500).json({
      success: false,
      error: 'OTP verification failed'
    });
  }
};

/**
 * Rate limiting middleware for sensitive operations
 */
const rateLimitSensitive = (maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
  const attempts = new Map();

  return async (req, res, next) => {
    try {
      const key = `${req.ip}:${req.path}`;
      const now = Date.now();
      
      // Clean old entries
      for (const [k, v] of attempts.entries()) {
        if (now - v.firstAttempt > windowMs) {
          attempts.delete(k);
        }
      }

      // Check current attempts
      const userAttempts = attempts.get(key);
      
      if (userAttempts) {
        if (userAttempts.count >= maxAttempts) {
          await AuditLog.logAction('RATE_LIMIT_EXCEEDED', {
            level: 'WARN',
            details: {
              ipAddress: req.ip,
              path: req.path,
              attempts: userAttempts.count,
              windowMs
            },
            severity: 6
          });

          return res.status(429).json({
            success: false,
            error: 'Too many attempts. Please try again later.',
            retryAfter: Math.ceil((userAttempts.firstAttempt + windowMs - now) / 1000)
          });
        }
        
        userAttempts.count++;
      } else {
        attempts.set(key, {
          count: 1,
          firstAttempt: now
        });
      }

      next();

    } catch (error) {
      console.error('Rate limiting error:', error);
      next(); // Continue on rate limiting errors
    }
  };
};

/**
 * Request validation middleware
 */
const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      const errors = [];

      // Validate required fields
      if (schema.required) {
        for (const field of schema.required) {
          if (!req.body[field]) {
            errors.push(`${field} is required`);
          }
        }
      }

      // Validate email fields
      if (schema.email) {
        for (const field of schema.email) {
          if (req.body[field]) {
            const validation = ValidationService.validateEmail(req.body[field]);
            if (!validation.isValid) {
              errors.push(...validation.errors);
            } else {
              req.body[field] = validation.sanitized;
            }
          }
        }
      }

      // Validate file uploads
      if (schema.file && req.file) {
        // File validation will be handled by multer and FileService
      }

      if (errors.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors
        });
      }

      next();

    } catch (error) {
      return res.status(500).json({
        success: false,
        error: 'Validation error'
      });
    }
  };
};

/**
 * Security headers middleware
 */
const securityHeaders = (req, res, next) => {
  // Remove server information
  res.removeHeader('X-Powered-By');
  
  // Set security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // Content Security Policy
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none';"
  );

  next();
};

/**
 * Request logging middleware
 */
const logRequest = async (req, res, next) => {
  try {
    const startTime = Date.now();
    
    // Log request
    await AuditLog.logAction('API_REQUEST', {
      level: 'INFO',
      details: {
        method: req.method,
        url: req.originalUrl,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        contentLength: req.get('Content-Length'),
        sessionId: req.session?.sessionId
      }
    });

    // Override res.end to log response
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
      const duration = Date.now() - startTime;
      
      // Log response (async, don't wait)
      AuditLog.logAction('API_RESPONSE', {
        level: 'INFO',
        details: {
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          duration,
          ipAddress: req.ip,
          sessionId: req.session?.sessionId
        }
      }).catch(console.error);

      originalEnd.call(this, chunk, encoding);
    };

    next();

  } catch (error) {
    console.error('Request logging error:', error);
    next(); // Continue on logging errors
  }
};

/**
 * Error handling middleware
 */
const errorHandler = async (err, req, res, next) => {
  try {
    // Log error
    await AuditLog.logAction('API_ERROR', {
      level: 'ERROR',
      details: {
        error: err.message,
        stack: err.stack,
        method: req.method,
        url: req.originalUrl,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      },
      severity: 8
    });

    // Handle specific error types
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: err.message
      });
    }

    if (err.name === 'MulterError') {
      let message = 'File upload error';
      if (err.code === 'LIMIT_FILE_SIZE') {
        message = 'File too large';
      } else if (err.code === 'LIMIT_FILE_COUNT') {
        message = 'Too many files';
      }
      
      return res.status(400).json({
        success: false,
        error: message
      });
    }

    // Generic error response
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });

  } catch (logError) {
    console.error('Error logging failed:', logError);
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
};

module.exports = {
  authenticateJWT,
  verifyOTP,
  rateLimitSensitive,
  validateRequest,
  securityHeaders,
  logRequest,
  errorHandler
};
