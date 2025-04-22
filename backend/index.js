// --- File: index.js (Backend Main Server - Final Corrected Version with Logging) ---

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
const connectDB = require('./config/db'); // Adjust path if needed
const Project = require('./models/project'); // Adjust path if needed

// --- Define and Register the YjsDoc Schema ---
const YjsDocSchema = new mongoose.Schema({
    name: { type: String, required: true, index: true, unique: true }, // Stores Project ObjectId (_id) string
    data: { type: Buffer, required: true }, // Stores Yjs binary state/updates
}, { timestamps: true });
const YjsDocModel = mongoose.model('YjsDoc', YjsDocSchema);
console.log('[Persistence] Mongoose model for YjsDoc registered.');
// --- END YjsDoc Schema Definition ---


// --- Persistence Setup ---
const docs = new Map(); // In-memory cache: roomName (projectId) -> WSSharedDoc instance
const debouncedSave = new Map(); // Debounce timers: roomName (projectId) -> timer ID
const debounceTimeout = 5000; // 5 seconds delay

// Debounced save function
const saveYDoc = async (doc) => {
    const roomName = doc.name;
    if (debouncedSave.has(roomName)) {
        clearTimeout(debouncedSave.get(roomName));
    }
    debouncedSave.set(roomName, setTimeout(async () => {
        console.log(`[Persistence ${roomName}] Debounced save triggered.`);
        try {
            const dataToSave = Y.encodeStateAsUpdate(doc);
            console.log(`[Persistence ${roomName}] Saving doc state (size: ${dataToSave.length} bytes)`);
            await YjsDocModel.findOneAndUpdate(
                { name: roomName },
                { data: Buffer.from(dataToSave) },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            console.log(`[Persistence ${roomName}] Successfully saved doc state.`);
        } catch (error) {
            console.error(`[Persistence ${roomName}] Error saving document state:`, error);
        } finally {
            debouncedSave.delete(roomName);
        }
    }, debounceTimeout));
};

// --- Yjs Document Class with WebSocket Handling ---
class WSSharedDoc extends Y.Doc {
    constructor(name) { // name = projectId (_id string)
        super({ gc: true });
        this.name = name;
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null);
        this.conns = new Map(); // ws -> Set<clientID>
        this.isLoaded = false; // Flag for initial data load state
        this.loadPromise = this.loadPersistedData(); // Start loading, store promise

        this.on('update', (update, origin) => {
            this._updateHandler(update, origin);
            saveYDoc(this);
        });
        this.awareness.on('update', this._awarenessUpdateHandler.bind(this));
    }

    async loadPersistedData() {
        console.log(`[Persistence ${this.name}] Checking DB for existing data...`);
        try {
            const dbDoc = await YjsDocModel.findOne({ name: this.name }).lean();
            if (dbDoc?.data) {
                console.log(`[Persistence ${this.name}] Found data (size: ${dbDoc.data.length} bytes). Applying update...`);
                try {
                    Y.applyUpdate(this, dbDoc.data, 'persistence');
                    console.log(`[Persistence ${this.name}] Successfully applied update. Doc state vector:`, Y.encodeStateVector(this));
                } catch (applyError) {
                    console.error(`[Persistence ${this.name}] !!! ERROR APPLYING PERSISTED UPDATE !!! :`, applyError);
                }
            } else {
                console.log(`[Persistence ${this.name}] No data found in DB. Starting fresh.`);
            }
        } catch (err) {
            console.error(`[Persistence ${this.name}] Error during findOne in loadPersistedData:`, err);
        } finally {
             this.isLoaded = true;
             console.log(`[Persistence ${this.name}] Load process finished (isLoaded=${this.isLoaded}).`);
        }
    }

    _awarenessUpdateHandler({ added, updated, removed }, connOrigin) {
         const changedClients = added.concat(updated).concat(removed);
         const connControlledIDs = connOrigin ? this.conns.get(connOrigin) : null;
         if (connOrigin && connControlledIDs) {
             added.forEach(clientID => { connControlledIDs.add(clientID); });
             removed.forEach(clientID => { connControlledIDs.delete(clientID); });
         }
         const encoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
         const buffer = Buffer.concat([Buffer.from([syncProtocol.messageAwareness]), encoder]);
         this.conns.forEach((controlledIDs, conn) => {
             if (conn !== connOrigin) {
                 try { conn.send(buffer); }
                 catch (e) { console.error(`[Awareness ${this.name}] Error sending update:`, e); this.removeConnection(conn); }
             }
         });
     }

     _updateHandler(update, origin) {
         const encoder = syncProtocol.writeUpdate(update);
         const buffer = Buffer.concat([Buffer.from([syncProtocol.messageSync]), encoder]);
         this.conns.forEach((controlledIDs, conn) => {
             if (conn !== origin) {
                 try { conn.send(buffer); }
                 catch (e) { console.error(`[Sync ${this.name}] Error sending update:`, e); this.removeConnection(conn); }
             }
         });
     }

    async addConnection(conn, userId) {
        console.log(`[WSSharedDoc ${this.name}] Adding connection for user: ${userId}. Waiting for initial load...`);
        await this.loadPromise; // Wait for loadPersistedData to finish
        console.log(`[WSSharedDoc ${this.name}] Document load completed (isLoaded=${this.isLoaded}). Proceeding with addConnection.`);

        this.conns.set(conn, new Set());

        console.log(`[WSSharedDoc ${this.name}] Preparing SyncStep1... Current doc clientID: ${this.clientID}`);
        let stateVector;
        try {
             stateVector = Y.encodeStateVector(this);
             console.log(`[WSSharedDoc ${this.name}] Current doc state vector (before sync):`, stateVector);
             if (!(stateVector instanceof Uint8Array)) {
                 console.error(`[WSSharedDoc ${this.name}] !!! Invalid state vector type:`, typeof stateVector);
             }
        } catch (svError) {
             console.error(`[WSSharedDoc ${this.name}] !!! ERROR encoding state vector !!!:`, svError);
             this.removeConnection(conn); return;
        }

        // --- Minimal Reproduction Test (Optional - keep commented out unless needed) ---
        /*
        try {
            const testDoc = new Y.Doc();
            console.log('[DEBUG] Testing writeSyncStep1 on brand new Y.Doc...');
            const testEncoder = syncProtocol.writeSyncStep1(testDoc);
            console.log('[DEBUG] writeSyncStep1 on new Y.Doc SUCCEEDED. Encoder length:', testEncoder?.length);
            testDoc.destroy(); // Clean up test doc
        } catch (testError) {
            console.error('[DEBUG] !!! writeSyncStep1 on new Y.Doc FAILED !!!:', testError);
        }
        */
        // --- End Minimal Test ---


        let syncEncoder;
        try {
             syncEncoder = syncProtocol.writeSyncStep1(this); // Where error might occur
        } catch (syncStep1Error) {
             console.error(`[WSSharedDoc ${this.name}] !!! ERROR during writeSyncStep1 !!!:`, syncStep1Error);
             console.error(`[WSSharedDoc ${this.name}] State Vector at time of error was:`, stateVector);
             this.removeConnection(conn); return;
        }

        const syncBuffer = Buffer.concat([Buffer.from([syncProtocol.messageSync]), syncEncoder]);
        try {
            console.log(`[WSSharedDoc ${this.name}] Sending SyncStep1 (size: ${syncBuffer.length} bytes)...`);
            conn.send(syncBuffer);
            console.log(`[WSSharedDoc ${this.name}] SyncStep1 sent.`);
        } catch (sendError) {
            console.error(`[WSSharedDoc ${this.name}] Error sending SyncStep1:`, sendError);
            this.removeConnection(conn); return;
        }

        // --- Awareness Protocol ---
        const awarenessStates = this.awareness.getStates();
        if (awarenessStates.size > 0) {
             console.log(`[WSSharedDoc ${this.name}] Preparing initial Awareness state (states: ${awarenessStates.size})...`);
            const awarenessEncoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys()));
            const awarenessBuffer = Buffer.concat([Buffer.from([syncProtocol.messageAwareness]), awarenessEncoder]);
            try {
                 console.log(`[WSSharedDoc ${this.name}] Sending initial Awareness state (size: ${awarenessBuffer.length} bytes)...`);
                conn.send(awarenessBuffer);
                 console.log(`[WSSharedDoc ${this.name}] Initial Awareness state sent.`);
            } catch (e) { console.error(`[WSSharedDoc ${this.name}] Error sending initial Awareness state:`, e); }
        } else {
             console.log(`[WSSharedDoc ${this.name}] No existing awareness states to send.`);
        }
        console.log(`[WSSharedDoc ${this.name}] Connection fully added and initialized for user: ${userId}`);
    }

    removeConnection(conn) {
        if (this.conns.has(conn)) {
            const controlledIds = this.conns.get(conn);
            console.log(`[WSSharedDoc ${this.name}] Removing connection (clientID count: ${controlledIds?.size || 0})...`);
            this.conns.delete(conn);
            if (controlledIds && controlledIds.size > 0) {
                 console.log(`[WSSharedDoc ${this.name}] Removing awareness states for clientIDs: ${Array.from(controlledIds).join(', ')}`);
                awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(controlledIds), 'disconnect');
            }
             console.log(`[WSSharedDoc ${this.name}] Connection removed. Remaining connections: ${this.conns.size}`);
             if (this.conns.size === 0) {
                 console.log(`[WSSharedDoc ${this.name}] Last connection closed. Doc remains in memory.`);
             }
        }
        try {
             if (conn && conn.readyState !== WebSocket.CLOSED && conn.readyState !== WebSocket.CLOSING) {
                 conn.close(1000, "Server removing connection");
             }
        } catch(closeError) {
             console.warn(`[WSSharedDoc ${this.name}] Error attempting to close WebSocket during removeConnection:`, closeError.message);
        }
    }
}

// --- Document Management ---
// --- Restored Original Caching Logic for getYDoc ---
const getYDoc = (docname) => {
    let doc = docs.get(docname);
    if (doc === undefined) {
        console.log(`[Yjs Doc Manager] Creating NEW doc instance in memory for room: ${docname}`);
        doc = new WSSharedDoc(docname); // Constructor handles loading persisted data
        docs.set(docname, doc);
    } else {
        console.log(`[Yjs Doc Manager] Reusing EXISTING doc instance from memory for room: ${docname}`);
    }
    return doc;
};
// --- END Restored Original getYDoc ---


// --- Server Setup ---
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS ? process.env.CORS_ALLOWED_ORIGINS.split(',') : ['http://localhost:3000', "https://unicode-two.vercel.app"];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      const msg = `CORS policy does not allow access from the specified Origin: ${origin}`;
      console.error(msg);
      callback(new Error(msg), false);
    }
  },
  credentials: true,
};
const app = express();
app.use(cors(corsOptions));
app.use(express.json());
connectDB();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
console.log('[WebSocket Server] Initialized (manual upgrade).');


// --- Permission Checking Function (Matches latest ProjectSchema) ---
async function checkUserPermission(userId, projectObjectId) {
    console.log(`[Permissions] Checking if user ${userId} can access project ${projectObjectId}`);
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(projectObjectId)) {
        console.warn(`[Permissions] Invalid format passed to checkUserPermission: userId (${userId}), projectObjectId (${projectObjectId})`);
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


// --- WebSocket Upgrade Handling & Authentication ---
server.on('upgrade', async (request, socket, head) => {
    console.log(`[Upgrade] Received upgrade request for URL: ${request.url}`);
    let userId;
    let projectObjectId; // Expecting the MongoDB _id here

    try {
        const parsedUrl = url.parse(request.url, true);
        const token = parsedUrl.query.token;
        projectObjectId = parsedUrl.query.projectId; // Should be the DB _id string

        if (!token || !projectObjectId) {
            console.error(`[Upgrade] Failed: Missing token (${!token ? 'yes' : 'no'}) or projectObjectId (${!projectObjectId ? 'yes' : 'no'})`);
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
        }

        // 1. Verify JWT Token & Extract User ID
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (jwtError) {
             console.error('[Upgrade] JWT Verification Failed:', jwtError.message);
             socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
        }
        userId = decoded.id; // Using 'id' field from payload
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            console.error(`[Upgrade] Failed: Invalid or missing user ID ('${userId}') from token payload.`);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
        }
        console.log(`[Upgrade] Token verified for userId: ${userId}`);

        // 2. Validate Project ID Format (must be ObjectId)
        if (!mongoose.Types.ObjectId.isValid(projectObjectId)) {
            console.warn(`[Upgrade] Invalid projectObjectId format detected: ${projectObjectId}. Rejecting.`);
            socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\nInvalid Project ID format.'); socket.destroy(); return;
        }
         console.log(`[Upgrade] Project ObjectId format valid: ${projectObjectId}`);

        // 3. Check User Permissions
        console.log(`[Upgrade] Checking permissions for userId: ${userId} on projectObjectId: ${projectObjectId}`);
        const hasPermission = await checkUserPermission(userId, projectObjectId);
        if (!hasPermission) {
            console.error(`[Upgrade] Permission check failed for user ${userId} on project ${projectObjectId}.`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
        }
        console.log(`[Upgrade] Permission granted for user ${userId} on projectObjectId: ${projectObjectId}`);

        // 4. Handshake with WebSocket Server
        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log(`[Upgrade] WebSocket handshake successful for projectObjectId: ${projectObjectId}`);
            ws.roomId = projectObjectId; // Attach the MongoDB ObjectId as roomId
            ws.userId = userId;
            wss.emit('connection', ws, request); // Emit connection event for the handler below
        });

    } catch (error) {
        console.error('[Upgrade] Unexpected error during upgrade process:', error);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
    }
});

// --- WebSocket Connection Handling ---
wss.on('connection', async (ws, req) => {
    const roomName = ws.roomId; // This is the projectObjectId string
    const userId = ws.userId;
    if (!roomName || !userId) {
         console.error(`[Connection] Internal Error: Missing roomId or userId on WebSocket object after upgrade. Closing connection.`);
         ws.close(1011, 'Internal Server Error: Connection metadata missing.');
         return;
    }
    console.log(`[Yjs Connection] Client connected. User: ${userId}, Room: ${roomName}`);
    try {
        const ydoc = getYDoc(roomName); // Get or create Yjs doc instance for this room
        if (!(ydoc instanceof WSSharedDoc)) {
             console.error(`[Yjs Connection] Failed to get valid ydoc instance for room ${roomName}. Type: ${typeof ydoc}. Closing connection.`);
             ws.close(1011, 'Internal Server Error: Document initialization failed');
             return;
        }

        // Await addConnection - ensures initial doc load is finished before proceeding
        await ydoc.addConnection(ws, userId);

        // Listeners are setup AFTER addConnection resolves successfully
        const messageListener = (messageBuffer) => {
             try {
                 const message = Buffer.from(messageBuffer);
                 const messageType = message[0];
                 switch (messageType) {
                     case syncProtocol.messageSync:
                         syncProtocol.readSyncMessage(message.slice(1), Y.encodeStateVector(ydoc), ydoc, ws);
                         break;
                     case syncProtocol.messageAwareness:
                         awarenessProtocol.applyAwarenessUpdate(ydoc.awareness, message.slice(1), ws);
                         break;
                     default:
                         console.warn(`[Yjs Message ${roomName}] Received unknown message type: ${messageType} from user: ${userId}`);
                 }
             } catch (error) {
                 console.error(`[Yjs Message ${roomName}] Error processing message from user ${userId}:`, error);
                 try { ydoc.removeConnection(ws); } catch (e) {} // Attempt cleanup
             }
        };
        ws.on('message', messageListener);

        const closeListener = (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'No reason given';
            console.log(`[Yjs Connection ${roomName}] Connection closed for user: ${userId}. Code: ${code}, Reason: ${reasonStr}`);
            const doc = getYDoc(roomName); // Get instance again for cleanup
             if (doc instanceof WSSharedDoc) {
                 // Check if this specific connection is still tracked by this instance
                 if (doc.conns.has(ws)) {
                    doc.removeConnection(ws);
                 } else {
                     // This might happen if connection closes rapidly after creation or during complex scenarios
                    console.warn(`[Yjs Connection ${roomName}] Close event for a connection not tracked by current doc instance.`);
                 }
             } else {
                 console.error(`[Yjs Connection ${roomName}] Could not get valid doc instance on close for user: ${userId}`);
             }
        };
        ws.on('close', closeListener);

        const errorListener = (error) => {
            console.error(`[Yjs Connection ${roomName}] WebSocket error for user ${userId}:`, error);
            const doc = getYDoc(roomName);
             if (doc instanceof WSSharedDoc) {
                 if (doc.conns.has(ws)) {
                    doc.removeConnection(ws); // Ensure cleanup on error
                 }
             }
        };
        ws.on('error', errorListener);

        console.log(`[Yjs Connection] Client connection listeners setup for room: ${roomName} (User: ${userId})`);

    } catch (error) {
        // This catches errors from getYDoc or the awaited ydoc.addConnection
        console.error(`[Yjs Connection] Error during connection setup (post-upgrade) for room ${roomName}, user ${userId}:`, error);
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
             ws.close(1011, 'Internal server error during connection setup');
        }
    }
});


// --- Socket.IO Server (Optional) ---
const io = new SocketIOServer(server, { cors: corsOptions });
io.on('connection', (socket) => {
    // console.log('[Socket.IO] User connected (separate from Yjs):', socket.id);
    socket.on('disconnect', () => { /* console.log('[Socket.IO] User disconnected:', socket.id); */ });
});

// --- Express Routes ---
app.get('/', (req, res) => { res.send('Collaboration Server is running.'); });
// Ensure these paths correctly point to your route files
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode"));

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}, accepting connections from all interfaces.`));