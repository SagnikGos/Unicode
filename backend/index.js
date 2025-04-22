// --- File: index.js (Backend Main Server - Using y-websocket) ---

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const url = require('url');
const Y = require('yjs');
// Import y-websocket utilities
const YWS = require('y-websocket/bin/utils'); // Common way to import utils

const connectDB = require('./config/db'); // Adjust path
const Project = require('./models/project'); // Adjust path
const User = require('./models/user'); // Needed for Project refs

// --- Define and Register the YjsDoc Schema ---
const YjsDocSchema = new mongoose.Schema({
    name: { type: String, required: true, index: true, unique: true }, // Stores Project ObjectId (_id) string
    data: { type: Buffer, required: true }, // Stores Yjs binary state/updates
}, { timestamps: true });
const YjsDocModel = mongoose.model('YjsDoc', YjsDocSchema);
console.log('[Persistence] Mongoose model for YjsDoc registered.');
// --- END YjsDoc Schema Definition ---


// --- y-websocket Persistence Hooks (using Mongoose) ---

// This object maps room names (project ObjectIds) to Y.Doc instances managed by y-websocket
const docs = YWS.docs; // Use the Map provided by y-websocket utils

// bindState: Loads document state from DB when a document/room is accessed for the first time.
const bindState = async (docName, ydoc) => { // docName is the projectId (_id string)
    console.log(`[Persistence ${docName}] bindState: Attempting to load data...`);
    try {
        const persistedDoc = await YjsDocModel.findOne({ name: docName }).lean();
        if (persistedDoc?.data) {
            console.log(`[Persistence ${docName}] bindState: Found data (size: ${persistedDoc.data.length} bytes). Applying update...`);
            Y.applyUpdate(ydoc, persistedDoc.data, 'persistence'); // Origin 'persistence'
            console.log(`[Persistence ${docName}] bindState: Update applied.`);
        } else {
             console.log(`[Persistence ${docName}] bindState: No persisted data found.`);
        }
    } catch (error) {
        console.error(`[Persistence ${docName}] bindState: Error loading document:`, error);
    }

    // Optional: Hook to perform actions when the document is modified *after* initial load
    ydoc.on('update', async (update, origin) => {
        // Example: Could trigger other actions, but saving is handled by writeState
        // console.log(`[Yjs Update ${docName}] Origin: ${origin}`);
    });
};

// writeState: Saves document state to DB periodically or on specific events.
// y-websocket calls this less frequently than our previous debounce logic.
// It's often called when no connections are left for a document.
const writeState = async (docName, ydoc) => { // docName is the projectId (_id string)
    console.log(`[Persistence ${docName}] writeState: Attempting to save data...`);
    try {
        const dataToSave = Y.encodeStateAsUpdate(ydoc);
        if (dataToSave.byteLength > 1) { // Avoid saving empty doc states unnecessarily (Y.Doc state vector [0] is 1 byte)
            console.log(`[Persistence ${docName}] writeState: Saving doc state (size: ${dataToSave.length} bytes)`);
            await YjsDocModel.findOneAndUpdate(
                { name: docName },
                { data: Buffer.from(dataToSave) },
                { upsert: true } // Create if missing, update if exists
            );
            console.log(`[Persistence ${docName}] writeState: Successfully saved doc state.`);
        } else {
             console.log(`[Persistence ${docName}] writeState: Document appears empty, skipping save.`);
        }
    } catch (error) {
        console.error(`[Persistence ${docName}] writeState: Error saving document state:`, error);
    }
};

// Configure y-websocket persistence
YWS.setPersistence({
    bindState: bindState,
    writeState: writeState
});
console.log("[y-websocket] Persistence hooks configured.");

// --- Permission Checking Function (Matches latest ProjectSchema) ---
// Keep this function as it's needed for the upgrade handler
async function checkUserPermission(userId, projectObjectId) {
    console.log(`[Permissions] Checking if user ${userId} can access project ${projectObjectId}`);
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(projectObjectId)) {
        console.warn(`[Permissions] Invalid format passed: userId (${userId}), projectObjectId (${projectObjectId})`);
        return false;
    }
    try {
        const project = await Project.findById(projectObjectId).select('users').lean();
        if (!project) {
            console.log(`[Permissions] Project ${projectObjectId} not found in DB.`);
            return false;
        }
        const isMember = project.users?.some(memberId => memberId.toString() === userId);
        if (isMember) {
             console.log(`[Permissions] Access granted for user ${userId} to project ${projectObjectId}.`);
            return true;
        } else {
             console.log(`[Permissions] Access denied for user ${userId} to project ${projectObjectId}. User not in 'users' array.`);
            return false;
        }
    } catch (error) {
        console.error(`[Permissions] DB Error checking permissions for user ${userId} on project ${projectObjectId}:`, error);
        return false;
    }
}
// --- END Permission Checking Function ---


// --- Server Setup ---
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS ? process.env.CORS_ALLOWED_ORIGINS.split(',') : ['http://localhost:3000', "https://unicode-two.vercel.app"];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) { callback(null, true); }
    else { const msg = `CORS policy ... Origin: ${origin}`; console.error(msg); callback(new Error(msg), false); }
  },
  credentials: true,
};
const app = express();
app.use(cors(corsOptions));
app.use(express.json());
connectDB(); // Establish MongoDB connection
const server = http.createServer(app); // Use 'server' instead of 'httpServer'

// --- Setup WebSocket Handling with y-websocket and Auth ---
const wss = YWS.createWebSocketServer(server); // Let y-websocket create the WebSocket server

// We still need to intercept the upgrade for Authentication/Authorization BEFORE y-websocket handles it
server.on('upgrade', async (request, socket, head) => {
    console.log(`[Upgrade] Received upgrade request for URL: ${request.url}`);
    let userId;
    let projectObjectId; // Expecting the MongoDB _id here

    // 1. Parse URL for token and projectObjectId
    try {
        const parsedUrl = url.parse(request.url, true);
        const token = parsedUrl.query.token;
        projectObjectId = parsedUrl.query.projectId; // Should be the DB _id string

        if (!token || !projectObjectId) {
            console.error(`[Upgrade] Failed: Missing token or projectObjectId`);
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
        }

        // 2. Verify JWT Token & Extract User ID
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (jwtError) {
             console.error('[Upgrade] JWT Verification Failed:', jwtError.message);
             socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
        }
        userId = decoded.id;
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            console.error(`[Upgrade] Failed: Invalid or missing user ID ('${userId}') from token.`);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
        }
        console.log(`[Upgrade] Token verified for userId: ${userId}`);

        // 3. Validate Project ID Format
        if (!mongoose.Types.ObjectId.isValid(projectObjectId)) {
            console.warn(`[Upgrade] Invalid projectObjectId format: ${projectObjectId}. Rejecting.`);
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid Project ID format.'); socket.destroy(); return;
        }
         console.log(`[Upgrade] Project ObjectId format valid: ${projectObjectId}`);

        // 4. Check User Permissions (using our existing function)
        console.log(`[Upgrade] Checking permissions for userId: ${userId} on projectObjectId: ${projectObjectId}`);
        const hasPermission = await checkUserPermission(userId, projectObjectId);
        if (!hasPermission) {
            console.error(`[Upgrade] Permission check failed for user ${userId} on project ${projectObjectId}.`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
        }
        console.log(`[Upgrade] Permission granted for user ${userId} on projectObjectId: ${projectObjectId}`);

        // 5. If Auth/Authz passes, let y-websocket handle the actual WebSocket connection setup
        // We pass the verified projectId as the 'docName' to y-websocket setup function below
        // Attach verified data to the request for setupWSConnection to use (optional but clean)
        request.verifiedUserId = userId;
        request.verifiedProjectObjectId = projectObjectId;

        // Let the y-websocket server instance handle the upgrade
        wss.handleUpgrade(request, socket, head, (ws) => {
             console.log(`[Upgrade] Handing off to y-websocket for projectObjectId: ${projectObjectId}`);
             // Pass the original request object so setupWSConnection can potentially access attached info
             YWS.setupWSConnection(ws, request, { docName: projectObjectId }); // Use projectId as docName/room
             // Optionally set awareness initial state here if needed
             // const awareness = YWS.docs.get(projectObjectId)?.awareness;
             // if (awareness) {
             //     awareness.setLocalStateField('user', { id: userId, name: 'UserName...' }); // Example
             // }
        });

    } catch (error) {
        console.error('[Upgrade] Unexpected error during upgrade process:', error);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
    }
});


// --- REMOVED: Custom WSSharedDoc Class ---
// --- REMOVED: Custom getYDoc Function ---
// --- REMOVED: Custom wss.on('connection') handler ---


// --- Socket.IO Server (Optional) ---
// This remains unchanged if you still need Socket.IO for other purposes
const io = new SocketIOServer(server, { cors: corsOptions });
io.on('connection', (socket) => {
    // console.log('[Socket.IO] User connected:', socket.id);
    socket.on('disconnect', () => { /* console.log('[Socket.IO] User disconnected:', socket.id); */ });
});

// --- Express Routes ---
app.get('/', (req, res) => { res.send('Collaboration Server (y-websocket) is running.'); });
// Ensure these paths correctly point to your route files
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode"));

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}, using y-websocket.`));