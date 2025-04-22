// --- Backend server file (e.g., index.js) ---
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const map = require('lib0/map');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const connectDB = require('./config/db');

// --- Import Mongoose Models ---
const Project = require('./models/project'); // <-- Import Project model (adjust path if needed)
// const User = require('./models/User'); // User model might not be needed directly here if JWT is sufficient

// --- Mongoose Schema for Yjs Docs ---
const YjsDocSchema = new mongoose.Schema({
    name: { type: String, required: true, index: true }, // Corresponds to projectId / room name
    data: { type: Buffer, required: true },
}, { timestamps: true });
const YjsDocModel = mongoose.model('YjsDoc', YjsDocSchema);
console.log('[Persistence] Mongoose model for YjsDoc registered.');

// --- Persistence (In-Memory Map) ---
const docs = new Map(); // Map<string, WSSharedDoc>

// --- Persistence Functions (Debounced Save to DB) ---
const debouncedSave = new Map();
const debounceTimeout = 5000;
const saveYDoc = async (doc) => { /* ... same as before ... */ };

// --- WSSharedDoc Class ---
class WSSharedDoc extends Y.Doc { /* ... same as before ... */ }

// --- Function to Get/Create/Load Yjs Document (from DB or New) ---
const getYDoc = (docname, gc = true) => map.setIfUndefined(docs, docname, () => {
    const doc = new WSSharedDoc(docname);
    console.log(`[Manual Yjs] Trying to load or create doc for room: ${docname}`);
    // Load YjsDoc state from database
    YjsDocModel.findOne({ name: docname }).then(dbDoc => {
        if (dbDoc?.data) {
            console.log(`[Persistence] Found Yjs data in DB for room: ${docname}. Applying update.`);
            Y.applyUpdate(doc, dbDoc.data);
        } else {
            console.log(`[Persistence] No Yjs data found in DB for room: ${docname}. Starting fresh.`);
            // ** Optional: Load initial code from Project model if YjsDoc is new? **
            // This adds complexity. Yjs should ideally become the source of truth.
            // Consider fetching project code here only if absolutely necessary for *first load*.
        }
        saveYDoc(doc); // Trigger initial debounced save
    }).catch(err => {
        console.error(`[Persistence] Error loading Yjs data for room ${docname}:`, err);
    });
    docs.set(docname, doc);
    return doc;
});

// --- CORS Configuration ---
const allowedOrigins = [ /* ... */ ];
const corsOptions = { /* ... */ };

// --- Express App Setup ---
const app = express();
app.use(cors(corsOptions));
app.use(express.json());

// --- Database Connection ---
connectDB();

// --- HTTP Server Setup ---
const server = http.createServer(app);

// --- Initialize WebSocket Server (wss) for Yjs ---
const wss = new WebSocket.Server({ noServer: true });
console.log('[Manual Yjs] WebSocket server initialized (manual upgrade).');

// --- Handle HTTP Server Upgrade Requests ---
server.on('upgrade', (request, socket, head) => {
    // Perform authentication and authorization before upgrading connection
    try {
        const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
        // Use the path segment as the projectId/roomName for lookup
        const roomName = parsedUrl.pathname.split('/').filter(Boolean)[0];
        const token = parsedUrl.searchParams.get('token');

        if (!roomName) {
            console.warn('[Auth Upgrade] Room name (projectId) missing in URL path. Destroying socket.');
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!token) {
            console.warn('[Auth Upgrade] No token on upgrade request. Destroying socket.');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
            if (err || !decoded || typeof decoded.id === 'undefined') {
                console.warn(`[Auth Upgrade] Invalid token on upgrade: ${err?.message || 'Invalid payload'}. Destroying socket.`);
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            // ** Authorization Check using Project Model **
            const userId = decoded.id;
            const hasPermission = await checkUserPermission(userId, roomName); // Use the updated function

            if (!hasPermission) {
                 console.warn(`[Auth Upgrade] User ${userId} forbidden for room ${roomName}. Destroying socket.`);
                 socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                 socket.destroy();
                 return;
             }

            // If auth/authz passes, complete the WebSocket upgrade
            wss.handleUpgrade(request, socket, head, (ws) => {
                 ws.roomId = roomName; // Attach room info
                 ws.userId = userId; // Attach user id
                 wss.emit('connection', ws, request); // Emit connection for the verified socket
             });
        });
    } catch (error) {
         console.error('[Auth Upgrade] Error during upgrade handling:', error);
         socket.destroy();
    }
});


// --- Handle WebSocket Connections ---
wss.on('connection', (ws, req) => {
    const roomName = ws.roomId || 'default-room'; // Get context from upgrade handler
    const userId = ws.userId || 'unknown';

    console.log(`[Manual Yjs] Verified client connected to room: ${roomName} (User: ${userId})`);

    try {
        // --- Yjs Setup ---
        const ydoc = getYDoc(roomName);
        ydoc.addConnection(ws);

        // Handle messages
        const messageListener = (message) => { /* ... same message handling ... */ };
        ws.on('message', messageListener);

        // Handle close
        const closeListener = () => { /* ... same close handling ... */ };
        ws.on('close', closeListener);

        // Handle error
        const errorListener = (error) => { /* ... same error handling ... */ };
        ws.on('error', errorListener);

        console.log(`[Manual Yjs] Client connection fully setup for room: ${roomName} (User: ${userId})`);

    } catch (error) {
        console.error(`[Manual Yjs] Unexpected error during connection setup (post-upgrade):`, error);
        ws.close(1011, 'Internal server error during connection setup');
    }
});

// --- Authorization Logic Implementation ---
async function checkUserPermission(userId, projectId) {
    console.log(`[Auth Check] Checking if user ${userId} can access project ${projectId}`);
    if (!userId || !projectId) {
        return false;
    }
    try {
        // Find the project by the projectId provided in the URL/roomName
        const project = await Project.findOne({ projectId: projectId });

        if (!project) {
            console.log(`[Auth Check] Project not found: ${projectId}`);
            return false; // Project doesn't exist
        }

        // Check if the 'users' array includes the userId from the JWT
        // Mongoose can compare the string userId with ObjectId references in the array
        const isUserAllowed = project.users.includes(userId);

        if (!isUserAllowed) {
            console.log(`[Auth Check] User ${userId} not found in users array for project ${projectId}`);
        }

        return isUserAllowed;

    } catch (error) {
        console.error(`[Auth Check] Database error during permission check for project ${projectId}:`, error);
        return false; // Deny access on error
    }
}
// --- End Authorization Logic Implementation ---


// --- Initialize Existing Socket.IO Server (io) --- (Optional)
const io = new Server(server, { cors: corsOptions });
// ... io setup ...


// --- API Routes ---
// Make sure paths to route files are correct relative to this index.js
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project')); // Assuming project routes exist
app.use("/api", require("./routes/runCode"));


// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[Server] HTTP & WebSocket server running on port ${PORT}`));