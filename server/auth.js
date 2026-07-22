const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

function authRequired(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

module.exports = { signToken, authRequired };
