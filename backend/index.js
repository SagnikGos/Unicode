// --- File: index.js ---

// ... other requires ...
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');
const WebSocket = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const url = require('url');
const connectDB = require('./config/db'); // Adjust path
const Project = require('./models/project'); // Adjust path
// const YjsDocModel = require('./models/yjsDoc'); // Make sure YjsDoc schema/model is defined elsewhere

// ... Persistence Setup, WSSharedDoc Class, getYDoc function (as before) ...
const YjsDocModel = mongoose.model('YjsDoc'); // Ensure this model is registered
const docs = new Map(); // In-memory cache for active Y.Doc objects
const debouncedSave = new Map(); // Map to store debounce timers for saving
const debounceTimeout = 5000; // Save documents 5 seconds after the last change

const saveYDoc = async (doc) => { /* ... saveYDoc function as before ... */
    const roomName = doc.name;
    if (debouncedSave.has(roomName)) { clearTimeout(debouncedSave.get(roomName)); }
    debouncedSave.set(roomName, setTimeout(async () => {
        console.log(`[Persistence] Debounced save triggered for room: ${roomName}`);
        try {
            const dataToSave = Y.encodeStateAsUpdate(doc);
            await YjsDocModel.findOneAndUpdate( { name: roomName }, { data: Buffer.from(dataToSave) }, { upsert: true, new: true, setDefaultsOnInsert: true });
            console.log(`[Persistence] Successfully saved doc for room: ${roomName}`);
        } catch (error) { console.error(`[Persistence] Error saving document for room ${roomName}:`, error);
        } finally { debouncedSave.delete(roomName); }
    }, debounceTimeout));
};
class WSSharedDoc extends Y.Doc { /* ... WSSharedDoc class definition as before ... */
    constructor(name) { super({ gc: true }); this.name = name; this.awareness = new awarenessProtocol.Awareness(this); this.awareness.setLocalState(null); this.conns = new Map(); this.on('update', (update, origin) => { this._updateHandler(update, origin); saveYDoc(this); }); this.awareness.on('update', this._awarenessUpdateHandler.bind(this)); this.loadPersistedData(); }
    async loadPersistedData() { /* ... */ }
    _awarenessUpdateHandler({ added, updated, removed }, connOrigin) { /* ... */ }
    _updateHandler(update, origin) { /* ... */ }
    addConnection(conn, userId) { /* ... */ }
    removeConnection(conn) { /* ... */ }
 }
const getYDoc = (docname) => { /* ... getYDoc function as before ... */
    let doc = docs.get(docname); if (doc === undefined) { console.log(`[Manual Yjs] Creating NEW doc instance in memory for room: ${docname}`); doc = new WSSharedDoc(docname); docs.set(docname, doc); } else { console.log(`[Manual Yjs] Reusing EXISTING doc instance from memory for room: ${docname}`); } return doc;
 };

// --- Server Setup ---
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS ? process.env.CORS_ALLOWED_ORIGINS.split(',') : ['http://localhost:3000', "https://unicode-two.vercel.app"];
const corsOptions = { /* ... corsOptions as before ... */
  origin: function (origin, callback) { if (!origin) return callback(null, true); if (allowedOrigins.indexOf(origin) === -1) { const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`; console.error(msg); return callback(new Error(msg), false); } return callback(null, true); }, credentials: true,
 };
const app = express();
app.use(cors(corsOptions));
app.use(express.json());
connectDB();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
console.log('[Manual Yjs] WebSocket server initialized (manual upgrade).');


// --- CORRECTED Permission Checking Function (Matches ProjectSchema) ---
async function checkUserPermission(userId, projectObjectId) { // Renamed param for clarity
    console.log(`[Permissions] Checking if user ${userId} can access project ${projectObjectId}`);

    // Validate formats (already done in upgrade handler, but good defense)
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(projectObjectId)) {
        console.warn(`[Permissions] Invalid userId (${userId}) or projectObjectId (${projectObjectId}) format.`);
        return false;
    }

    try {
        // Find project by its MongoDB _id, select only the 'users' array
        const project = await Project.findById(projectObjectId).select('users').lean();

        if (!project) {
            console.log(`[Permissions] Project ${projectObjectId} not found.`);
            return false; // Project doesn't exist
        }

        // Check if the userId is included in the 'users' array
        // No 'owner' field check needed based on the provided schema
        const isMember = project.users?.some(memberId => memberId.toString() === userId);

        if (isMember) {
             console.log(`[Permissions] Access granted for user ${userId} to project ${projectObjectId}. User is in 'users' array.`);
            return true;
        } else {
             console.log(`[Permissions] Access denied for user ${userId} to project ${projectObjectId}. User not in 'users' array.`);
            return false;
        }
    } catch (error) {
        console.error(`[Permissions] Error checking permissions for user ${userId} on project ${projectObjectId}:`, error);
        return false; // Deny access on error
    }
}
// --- END CORRECTED Permission Checking Function ---


// --- WebSocket Upgrade Handling & Authentication ---
server.on('upgrade', async (request, socket, head) => {
    console.log('[Upgrade] Received upgrade request.');
    let userId;
    let projectObjectId; // Rename to clarify it should be the ObjectId

    try {
        const parsedUrl = url.parse(request.url, true);
        const token = parsedUrl.query.token;
        // This param from the client SHOULD be the MongoDB ObjectId now
        projectObjectId = parsedUrl.query.projectId;

        if (!token || !projectObjectId) {
            // ... error handling for missing params ...
            console.error(`[Upgrade] Failed: Missing token (${!token ? 'yes' : 'no'}) or projectObjectId (${!projectObjectId ? 'yes' : 'no'}) in query parameters.`); console.error(`[Upgrade] Received URL: ${request.url}`); socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
        }

        // 1. Verify JWT Token & Extract User ID (using 'id' key)
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id;
        if (!userId) {
            // ... error handling for missing id in token ...
             console.error('[Upgrade] Failed: User ID missing from token payload (key "id").'); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
        }
        console.log(`[Upgrade] Token verified for userId: ${userId}`);

        // 2. Validate Project ID Format
        if (!mongoose.Types.ObjectId.isValid(projectObjectId)) {
            console.warn(`[Upgrade] Invalid projectObjectId format detected: ${projectObjectId}. Rejecting.`);
            socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\nInvalid Project ID format.');
            socket.destroy();
            return;
        }
         console.log(`[Upgrade] Project ObjectId format valid: ${projectObjectId}`);

        // 3. Check User Permissions using the updated function
        console.log(`[Upgrade] Checking permissions for userId: ${userId} on projectObjectId: ${projectObjectId}`);
        const hasPermission = await checkUserPermission(userId, projectObjectId); // Use updated function
        if (!hasPermission) {
            console.error(`[Upgrade] Failed: User ${userId} does not have permission for project ${projectObjectId}.`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        console.log(`[Upgrade] Permission granted for userId: ${userId} on projectObjectId: ${projectObjectId}`);

        // 4. Handshake with WebSocket Server
        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log(`[Upgrade] WebSocket handshake successful for projectObjectId: ${projectObjectId}`);
            ws.roomId = projectObjectId; // Attach the ObjectId as roomId
            ws.userId = userId;
            wss.emit('connection', ws, request);
        });

    } catch (error) {
        // ... error handling for upgrade process ...
        console.error('[Upgrade] Failed during upgrade process:', error.message); if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } else { console.error('[Upgrade] Unexpected Error:', error); socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); } socket.destroy();
    }
});

// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => { /* ... wss.on('connection') handler as before ... */
    const roomName = ws.roomId; const userId = ws.userId; if (!roomName || !userId) { console.error(`[Connection] Internal Error: Missing roomId or userId on WebSocket object after upgrade. Closing connection.`); ws.close(1011, 'Internal Server Error: Connection metadata missing.'); return; } console.log(`[Manual Yjs] Verified client connected. User: ${userId}, Room: ${roomName}`); try { const ydoc = getYDoc(roomName); if (!(ydoc instanceof WSSharedDoc) || typeof ydoc.addConnection !== 'function') { console.error(`[Manual Yjs] Failed to get valid ydoc instance for room ${roomName}. Type: ${typeof ydoc}. Closing connection.`); ws.close(1011, 'Internal Server Error: Document initialization failed'); return; } ydoc.addConnection(ws, userId); const messageListener = (messageBuffer) => { try { const message = Buffer.from(messageBuffer); const messageType = message[0]; switch (messageType) { case syncProtocol.messageSync: syncProtocol.readSyncMessage(message.slice(1), Y.encodeStateVector(ydoc), ydoc, ws); break; case syncProtocol.messageAwareness: awarenessProtocol.applyAwarenessUpdate(ydoc.awareness, message.slice(1), ws); break; default: console.warn(`[Manual Yjs ${roomName}] Received unknown message type: ${messageType} from user: ${userId}`); } } catch (error) { console.error(`[Manual Yjs ${roomName}] Error processing message from user ${userId}:`, error); ydoc.removeConnection(ws); } }; ws.on('message', messageListener); const closeListener = (code, reason) => { const reasonStr = reason ? reason.toString() : 'No reason given'; console.log(`[Manual Yjs ${roomName}] Connection closed for user: ${userId}. Code: ${code}, Reason: ${reasonStr}`); const doc = getYDoc(roomName); if (doc instanceof WSSharedDoc) { doc.removeConnection(ws); } else { console.error(`[Manual Yjs ${roomName}] Could not find valid doc instance on close for user: ${userId}`); } }; ws.on('close', closeListener); const errorListener = (error) => { console.error(`[Manual Yjs ${roomName}] WebSocket error for user ${userId}:`, error); const doc = getYDoc(roomName); if (doc instanceof WSSharedDoc) { doc.removeConnection(ws); } }; ws.on('error', errorListener); console.log(`[Manual Yjs] Client connection fully setup for room: ${roomName} (User: ${userId})`); } catch (error) { console.error(`[Manual Yjs] Unexpected error during connection setup (post-upgrade) for room ${roomName}, user ${userId}:`, error); if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) { ws.close(1011, 'Internal server error during connection setup'); } }
});


// --- Socket.IO Server (Optional) ---
const io = new SocketIOServer(server, { cors: corsOptions });
io.on('connection', (socket) => { /* ... Socket.IO handler ... */ });

// --- Express Routes ---
app.get('/', (req, res) => { res.send('Collaboration Server is running.'); });
app.use('/api/auth', require('./routes/auth')); // Adjust path
app.use('/api/projects', require('./routes/project')); // Adjust path
app.use("/api", require("./routes/runCode")); // Adjust path

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}, accepting connections from all interfaces.`));