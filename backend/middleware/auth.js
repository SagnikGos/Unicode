// middleware/auth.js
const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
    // Get token from header
    const token = req.header('Authorization'); // Expecting "Bearer <token>"

    // Check if no token
    if (!token) {
        return res.status(401).json({ msg: 'No token, authorization denied' });
    }

    // Verify token
    try {
        // Extract token from "Bearer <token>"
        const actualToken = token.split(' ')[1];
        if (!actualToken) {
             return res.status(401).json({ msg: 'Token format invalid, authorization denied' });
        }

        const decoded = jwt.verify(actualToken, process.env.JWT_SECRET);
        // Attach user info (just the ID from the payload) to the request object
        req.user = decoded; // req.user will be { id: 'user-id-from-token', ...other payload }
        next(); // Proceed to the route handler
    } catch (err) {
        res.status(401).json({ msg: 'Token is not valid' });
    }
};