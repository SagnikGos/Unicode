// --- File: index.js (Backend Main Server - Corrected) ---

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io'); // Renamed to avoid conflict
const WebSocket = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const url = require('url'); // Needed for parsing URL in upgrade handler
const connectDB = require('./config/db'); // Adjust path if needed
const Project = require('./models/project'); // Adjust path if needed
// NOTE: User model isn't directly used in index.js, but required by Project model refs

// --- Define and Register the YjsDoc Schema ---
// This block defines the schema for storing Yjs document updates
const YjsDocSchema = new mongoose.Schema({
    // 'name' should store the unique identifier for the Yjs document room.
    // This should typically be the Project's MongoDB ObjectId (_id).
    name: {
        type: String,
        required: true,
        index: true, // Index for faster lookups
        unique: true  // Each Yjs doc room name must be unique
    },
    // 'data' stores the binary Yjs document state or updates
    data: {
        type: Buffer,
        required: true
    },
}, { timestamps: true }); // Adds createdAt and updatedAt automatically

// Register the schema as a Mongoose model named 'YjsDoc'
const YjsDocModel = mongoose.model('YjsDoc', YjsDocSchema);
console.log('[Persistence] Mongoose model for YjsDoc registered.');
// --- END YjsDoc Schema Definition ---


// --- Persistence Setup ---
// In-memory cache for active Y.Doc objects (maps roomName -> WSSharedDoc instance)
const docs = new Map();
// Map to store debounce timers for saving (maps roomName -> setTimeout timer ID)
const debouncedSave = new Map();
// Delay in milliseconds before saving after the last change
const debounceTimeout = 5000;

// Debounced function to save Yjs document state to MongoDB
const saveYDoc = async (doc) => {
    const roomName = doc.name; // roomName is the projectId (_id)
    if (debouncedSave.has(roomName)) {
        clearTimeout(debouncedSave.get(roomName)); // Clear existing timer if update occurs quickly
    }
    // Set a new timer
    debouncedSave.set(roomName, setTimeout(async () => {
        console.log(`[Persistence] Debounced save triggered for room: ${roomName}`);
        try {
            // Encode the entire document state as a single update message
            const dataToSave = Y.encodeStateAsUpdate(doc);
            // Find the DB document by name (projectId) and update it, or create if not found (upsert)
            await YjsDocModel.findOneAndUpdate(
                { name: roomName }, // Find by the Yjs room name (projectId)
                { data: Buffer.from(dataToSave) }, // Set the new data
                { upsert: true, new: true, setDefaultsOnInsert: true } // Options: create if missing, return new doc, set schema defaults
            );
            console.log(`[Persistence] Successfully saved doc for room: ${roomName}`);
        } catch (error) {
            console.error(`[Persistence] Error saving document for room ${roomName}:`, error);
        } finally {
            // Remove the timer entry after execution (success or error)
            debouncedSave.delete(roomName);
        }
    }, debounceTimeout));
};

// --- Yjs Document Class with WebSocket Handling ---
// Extends Y.Doc to add connection management, awareness, and persistence hooks
class WSSharedDoc extends Y.Doc {
    constructor(name) { // 'name' is the projectId (_id) used as the room identifier
        super({ gc: true }); // Enable Yjs garbage collection
        this.name = name;
        // Awareness protocol handles cursor positions, selections, user names, etc.
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null); // Initialize server's awareness state (usually null)

        // Map to store WebSocket connections (ws -> Set<clientID>)
        this.conns = new Map();

        // --- Event Listeners ---
        // 1. On 'update': When the Yjs document changes (locally or from applying remote update)
        this.on('update', (update, origin) => {
            this._updateHandler(update, origin); // Broadcast update to other clients
            saveYDoc(this); // Trigger debounced save to DB
        });

        // 2. On 'awareness': When awareness info (e.g., cursor) changes
        this.awareness.on('update', this._awarenessUpdateHandler.bind(this));

        // Load persisted data from DB when this shared doc instance is created
        this.loadPersistedData();
    }

    // Load initial state from MongoDB
    async loadPersistedData() {
        console.log(`[Persistence] Checking DB for existing data for room: ${this.name}`);
        try {
            const dbDoc = await YjsDocModel.findOne({ name: this.name });
            if (dbDoc?.data) {
                console.log(`[Persistence] Found data in DB for room: ${this.name}. Applying update.`);
                // Apply the saved state to this Y.Doc instance
                Y.applyUpdate(this, dbDoc.data, 'persistence'); // 'persistence' origin prevents immediate re-save loop
            } else {
                console.log(`[Persistence] No data found in DB for room: ${this.name}. Starting fresh.`);
            }
        } catch (err) {
            console.error(`[Persistence] Error loading document for room ${this.name}:`, err);
        }
    }

    // Handle broadcasting Awareness updates
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
             if (conn !== connOrigin) { // Don't echo back to sender
                 try { conn.send(buffer); }
                 catch (e) { console.error(`[Awareness ${this.name}] Error sending update:`, e); this.removeConnection(conn); }
             }
         });
     }

    // Handle broadcasting Yjs document updates
     _updateHandler(update, origin) {
         const encoder = syncProtocol.writeUpdate(update);
         const buffer = Buffer.concat([Buffer.from([syncProtocol.messageSync]), encoder]);
         this.conns.forEach((controlledIDs, conn) => {
             if (conn !== origin) { // Don't echo back to sender
                 try { conn.send(buffer); }
                 catch (e) { console.error(`[Sync ${this.name}] Error sending update:`, e); this.removeConnection(conn); }
             }
         });
     }

    // Add a new client connection
    addConnection(conn, userId) {
        console.log(`[WSSharedDoc ${this.name}] Adding connection for user: ${userId}`);
        this.conns.set(conn, new Set()); // Register connection

        // --- Sync Protocol Step 1: Send full doc state to new client ---
        console.log(`[WSSharedDoc ${this.name}] Preparing SyncStep1...`);
        const syncEncoder = syncProtocol.writeSyncStep1(this);
        const syncBuffer = Buffer.concat([Buffer.from([syncProtocol.messageSync]), syncEncoder]);
        try {
            console.log(`[WSSharedDoc ${this.name}] Sending SyncStep1...`);
            conn.send(syncBuffer);
        } catch (e) {
            console.error(`[WSSharedDoc ${this.name}] Error sending SyncStep1:`, e);
            this.removeConnection(conn); return; // Disconnect if initial sync fails
        }
        console.log(`[WSSharedDoc ${this.name}] SyncStep1 sent.`);

        // --- Awareness Protocol: Send current states of others to new client ---
        const awarenessStates = this.awareness.getStates();
        if (awarenessStates.size > 0) {
             console.log(`[WSSharedDoc ${this.name}] Preparing initial Awareness state...`);
            const awarenessEncoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys()));
            const awarenessBuffer = Buffer.concat([Buffer.from([syncProtocol.messageAwareness]), awarenessEncoder]);
            try {
                 console.log(`[WSSharedDoc ${this.name}] Sending initial Awareness state...`);
                conn.send(awarenessBuffer);
                 console.log(`[WSSharedDoc ${this.name}] Initial Awareness state sent.`);
            } catch (e) { console.error(`[WSSharedDoc ${this.name}] Error sending initial Awareness state:`, e); }
        } else {
             console.log(`[WSSharedDoc ${this.name}] No existing awareness states to send.`);
        }
        console.log(`[WSSharedDoc ${this.name}] Connection added and initialized for user: ${userId}`);
    }

    // Remove a client connection
    removeConnection(conn) {
        if (this.conns.has(conn)) {
            console.log(`[WSSharedDoc ${this.name}] Removing connection...`);
            const controlledIds = this.conns.get(conn);
            this.conns.delete(conn);
            if (controlledIds && controlledIds.size > 0) {
                 console.log(`[WSSharedDoc ${this.name}] Removing awareness states for clientIDs: ${Array.from(controlledIds).join(', ')}`);
                // Notify other clients that these awareness states are gone
                awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(controlledIds), 'disconnect');
            }
             console.log(`[WSSharedDoc ${this.name}] Connection removed. Remaining connections: ${this.conns.size}`);
             if (this.conns.size === 0) {
                 console.log(`[WSSharedDoc ${this.name}] Last connection closed. Triggering immediate save.`);
                 // Optional: Force save immediately when last user leaves
                 // clearTimeout(debouncedSave.get(this.name)); // Clear any pending debounce timer
                 // debouncedSave.delete(this.name);
                 // saveYDoc(this); // Or call save directly without timeout if needed
             }
        }
        // Ensure socket is closed
        if (conn && conn.readyState !== WebSocket.CLOSED && conn.readyState !== WebSocket.CLOSING) {
            conn.close();
        }
    }
}

// --- Document Management ---
// Function to get or create a WSSharedDoc instance for a given roomName (projectId)
const getYDoc = (docname) => {
    let doc = docs.get(docname);
    if (doc === undefined) {
        console.log(`[Manual Yjs] Creating NEW doc instance in memory for room: ${docname}`);
        doc = new WSSharedDoc(docname); // Constructor handles loading persisted data
        docs.set(docname, doc);
    } else {
        console.log(`[Manual Yjs] Reusing EXISTING doc instance from memory for room: ${docname}`);
    }
    return doc;
};

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
connectDB(); // Establish MongoDB connection

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true }); // Manual upgrade handling
console.log('[Manual Yjs] WebSocket server initialized.');


// --- Permission Checking Function (Matches latest ProjectSchema) ---
async function checkUserPermission(userId, projectObjectId) {
    console.log(`[Permissions] Checking if user ${userId} can access project ${projectObjectId}`);
    // Format validation happens in upgrade handler before this now
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
             console.log(`[Permissions] Access granted for user ${userId} to project ${projectObjectId}. User is in 'users' array.`);
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
        projectObjectId = parsedUrl.query.projectId; // Should be the DB _id

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
        if (!userId) {
            console.error('[Upgrade] Failed: User ID missing from token payload (key "id").');
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
            // Log denial reason from checkUserPermission is sufficient
            console.error(`[Upgrade] Permission check failed for user ${userId} on project ${projectObjectId}.`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
        }
        console.log(`[Upgrade] Permission granted for user ${userId} on projectObjectId: ${projectObjectId}`);

        // 4. Handshake with WebSocket Server
        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log(`[Upgrade] WebSocket handshake successful for projectObjectId: ${projectObjectId}`);
            ws.roomId = projectObjectId; // Attach the MongoDB ObjectId as roomId
            ws.userId = userId;
            wss.emit('connection', ws, request);
        });

    } catch (error) {
        // Catch unexpected errors during the upgrade process (e.g., jwt.verify issues not caught above)
        console.error('[Upgrade] Unexpected error during upgrade process:', error);
        // Avoid sending detailed error messages to client in production
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
    }
});

// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => {
    const roomName = ws.roomId; // This is the projectObjectId
    const userId = ws.userId;
    if (!roomName || !userId) {
         console.error(`[Connection] Internal Error: Missing roomId or userId on WebSocket object after upgrade. Closing connection.`);
         ws.close(1011, 'Internal Server Error: Connection metadata missing.');
         return;
    }
    console.log(`[Yjs Connection] Client connected. User: ${userId}, Room: ${roomName}`);
    try {
        const ydoc = getYDoc(roomName); // Get or create Yjs doc instance
        if (!(ydoc instanceof WSSharedDoc)) { // Basic type check
             console.error(`[Yjs Connection] Failed to get valid ydoc instance for room ${roomName}. Type: ${typeof ydoc}. Closing connection.`);
             ws.close(1011, 'Internal Server Error: Document initialization failed');
             return;
        }
        ydoc.addConnection(ws, userId); // Add connection to Yjs doc management

        // --- WebSocket Message Listener ---
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
                 try { ydoc.removeConnection(ws); } catch (e) {} // Attempt cleanup on error
             }
        };
        ws.on('message', messageListener);

        // --- WebSocket Close Listener ---
        const closeListener = (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'No reason given';
            console.log(`[Yjs Connection ${roomName}] Connection closed for user: ${userId}. Code: ${code}, Reason: ${reasonStr}`);
            // Ensure correct doc instance is retrieved for cleanup
             const doc = getYDoc(roomName); // Re-get instance
             if (doc instanceof WSSharedDoc) {
                doc.removeConnection(ws);
             }
        };
        ws.on('close', closeListener);

        // --- WebSocket Error Listener ---
        const errorListener = (error) => {
            console.error(`[Yjs Connection ${roomName}] WebSocket error for user ${userId}:`, error);
             const doc = getYDoc(roomName);
             if (doc instanceof WSSharedDoc) {
                 doc.removeConnection(ws); // Ensure cleanup on error
             }
        };
        ws.on('error', errorListener);

        console.log(`[Yjs Connection] Client connection listeners setup for room: ${roomName} (User: ${userId})`);

    } catch (error) {
        console.error(`[Yjs Connection] Unexpected error during connection setup (post-upgrade) for room ${roomName}, user ${userId}:`, error);
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
             ws.close(1011, 'Internal server error during connection setup');
        }
    }
});


// --- Socket.IO Server (Optional, only if needed for other features) ---
const io = new SocketIOServer(server, { cors: corsOptions });
io.on('connection', (socket) => {
    console.log('[Socket.IO] User connected (separate from Yjs):', socket.id);
    socket.on('disconnect', () => { console.log('[Socket.IO] User disconnected:', socket.id); });
});

// --- Express Routes ---
app.get('/', (req, res) => { res.send('Collaboration Server is running.'); });
// Ensure these paths correctly point to your route files
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode")); // Assuming this handles code execution

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}, accepting connections from all interfaces.`));