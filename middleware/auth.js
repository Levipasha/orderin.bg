import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  let token;
  
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Not authorized to access this route' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_jwt_secret_token');
    req.user = await User.findById(decoded.id).select('-password');
    
    if (!req.user || req.user.status === 'inactive') {
      return res.status(401).json({ success: false, error: 'User account is deactivated or does not exist' });
    }
    
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid authentication token' });
  }
};

// Role authorization guard
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `User role '${req.user?.role || 'guest'}' is not authorized to access this resource`
      });
    }
    next();
  };
};
