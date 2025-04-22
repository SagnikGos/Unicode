// --- Backend server file (e.g., server.js) ---
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
const mongoose = require('mongoose'); // <-- For Persistence
const jwt = require('jsonwebtoken'); // <-- For Auth
const connectDB = require('./config/db');

// --- Mongoose Schema for Yjs Docs ---
const YjsDocSchema = new mongoose.Schema({
    name: { type: String, required: true, index: true }, // room name / projectId
    data: { type: Buffer, required: true },      // Yjs document update binary data
}, { timestamps: true }); // Add timestamps

const YjsDocModel = mongoose.model('YjsDoc', YjsDocSchema);
console.log('[Persistence] Mongoose model for YjsDoc registered.');

// --- Persistence (In-Memory - NOT FOR PRODUCTION) ---
const docs = new Map(); // Map<string, WSSharedDoc> // <--- THIS LINE WAS MISSING, ADDED BACK
// Stores Y.Doc objects in memory, keyed by projectId (room name)
// IMPORTANT: Data is lost on server restart. Replace with persistent storage.

// --- Persistence Functions ---
const debouncedSave = new Map(); // Map<string, NodeJS.Timeout>
const debounceTimeout = 5000; // Save after 5 seconds of inactivity

const saveYDoc = async (doc) => {
    const roomName = doc.name;
    // Clear any existing debounce timer for this room
    if (debouncedSave.has(roomName)) {
        clearTimeout(debouncedSave.get(roomName));
    }

    // Set a new timer
    debouncedSave.set(roomName, setTimeout(async () => {
        console.log(`[Persistence] Debounced save triggered for room: ${roomName}`);
        try {
            const dataToSave = Y.encodeStateAsUpdate(doc); // Get document state as a binary update
            // Upsert: update if exists, insert if new
            await YjsDocModel.findOneAndUpdate(
                { name: roomName },
                { data: Buffer.from(dataToSave) }, // Store as Buffer
                { upsert: true, new: true }
            );
            console.log(`[Persistence] Successfully saved doc for room: ${roomName}`);
        } catch (error) {
            console.error(`[Persistence] Error saving document for room ${roomName}:`, error);
        } finally {
             debouncedSave.delete(roomName); // Clear timer entry after execution
        }
    }, debounceTimeout));
};


// --- WSSharedDoc Class (Modified for Persistence Trigger) ---
class WSSharedDoc extends Y.Doc {
    constructor(name) {
        super({ gc: true });
        this.name = name;
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null);
        this.conns = new Map(); // Map<WebSocket, Set<number>>

        // Trigger debounced save on document update
        this.on('update', (update, origin) => {
            this._updateHandler(update, origin);
            // Trigger save whenever the document changes (debounced)
            saveYDoc(this); // Pass the current doc instance
        });
        // Trigger save on awareness change too? Optional, depends if you need to persist awareness often.
        this.awareness.on('update', this._awarenessUpdateHandler.bind(this));
    }

     _awarenessUpdateHandler({ added, updated, removed }, conn) {
        // ... (awareness broadcasting logic) ...
         const changedClients = added.concat(updated, removed);
         if (conn !== null) {
            const connControlledIDs = this.conns.get(conn);
            if (connControlledIDs !== undefined) {
                added.forEach(clientID => { connControlledIDs.add(clientID); });
                removed.forEach(clientID => { connControlledIDs.delete(clientID); });
            }
         }
         const encoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
         const message = awarenessProtocol.encodeAwarenessMessage(encoder);
         this.conns.forEach((controlledIds, c) => {
            if (c !== conn) {
                try { c.send(message); } catch (e) { console.error(e); c.close(); }
            }
         });
     }

     _updateHandler(update, origin) {
        // ... (document update broadcasting logic) ...
         const encoder = syncProtocol.writeUpdate(update);
         const message = syncProtocol.encodeSyncMessage(encoder);
         this.conns.forEach((controlledIds, conn) => {
             if (conn !== origin) {
                 try { conn.send(message); } catch (e) { console.error(e); conn.close(); }
             }
         });
     }

    addConnection(conn) {
        // ... (add to this.conns, send sync step 1, send awareness) ...
         this.conns.set(conn, new Set());
         const encoder = syncProtocol.writeSyncStep1(this);
         try { conn.send(syncProtocol.encodeSyncMessage(encoder)); } catch (e) { console.error(e); conn.close(); }
         if (this.awareness.getStates().size > 0) {
             const awarenessEncoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys()));
             try { conn.send(awarenessProtocol.encodeAwarenessMessage(awarenessEncoder)); } catch (e) { console.error(e); conn.close(); }
         }
    }

    removeConnection(conn) {
        // ... (remove from awareness, delete from this.conns) ...
         const controlledIds = this.conns.get(conn);
         this.conns.delete(conn);
         if (controlledIds) {
             awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(controlledIds), null);
         }
         // Optional: Trigger immediate save on last disconnect if desired
         // if (this.conns.size === 0) { saveYDoc(this); }
    }
}

// --- Modified getYDoc to Load from DB ---
const getYDoc = (docname, gc = true) => map.setIfUndefined(docs, docname, () => {
    const doc = new WSSharedDoc(docname); // Use custom class
    console.log(`[Manual Yjs] Trying to load or create doc for room: ${docname}`);

    // Load document state from database
    YjsDocModel.findOne({ name: docname }).then(dbDoc => {
        if (dbDoc && dbDoc.data) {
            console.log(`[Persistence] Found existing doc in DB for room: ${docname}. Applying update.`);
            Y.applyUpdate(doc, dbDoc.data);
        } else {
            console.log(`[Persistence] No existing doc found in DB for room: ${docname}. Starting fresh.`);
        }
         // Trigger initial save after loading/creating (starts debounce timer)
         saveYDoc(doc);
    }).catch(err => {
        console.error(`[Persistence] Error loading document for room ${docname}:`, err);
    });

    docs.set(docname, doc); // Add the new doc instance to the in-memory map
    return doc;
});


// --- CORS Configuration ---
const allowedOrigins = [
    'https://unicode-two.vercel.app', // Your frontend deployment
    'http://localhost:3000',        // Common local dev ports
    'http://localhost:5173',
];
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            callback(new Error(msg), false);
        }
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true
};

// --- Express App Setup ---
const app = express();
app.use(cors(corsOptions));
app.use(express.json());

// --- Database Connection ---
connectDB();

// --- HTTP Server Setup ---
const server = http.createServer(app);

// --- Initialize WebSocket Server (wss) for Yjs ---
const wss = new WebSocket.Server({ server });
console.log('[Manual Yjs] WebSocket server initialized.');

// --- Handle WebSocket Connections (With Auth & Persistence Hooks) ---
wss.on('connection', async (ws, req) => { // Make handler async
    console.log('[Manual Yjs] Client attempting WebSocket connection...');
    let roomName = 'default-room'; // Fallback
    let user = null; // To store authenticated user info

    try {
        // --- Authentication ---
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const token = parsedUrl.searchParams.get('token');

        if (!token) {
            console.warn('[Auth] No token provided. Closing connection.');
            ws.close(4001, 'Unauthorized: No token');
            return;
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            user = decoded;
            // Log carefully - avoid logging sensitive parts of payload if any
            console.log(`[Auth] Token verified successfully for user ID: ${user.userId || '(userId missing in token)'}`);
        } catch (err) {
            console.warn(`[Auth] Invalid token: ${err.message}. Closing connection.`);
            ws.close(4002, 'Unauthorized: Invalid token');
            return;
        }

        // Determine room name (projectId) from URL path
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        if (pathSegments.length > 0) {
            roomName = pathSegments[0];
        } else {
             console.warn(`[Manual Yjs] Could not derive room name from URL: ${req.url}. Using default.`);
             // Maybe close connection if room is mandatory?
             // ws.close(1011, 'Cannot determine room'); return;
        }
        console.log(`[Manual Yjs] Client trying to access room: ${roomName}`);

        // --- Authorization ---
        // IMPORTANT: Replace placeholder logic
        if (!user || typeof user.userId === 'undefined') {
             console.warn(`[Auth] Cannot perform authorization check without valid userId in token payload. Closing connection.`);
             ws.close(4001, 'Unauthorized: Invalid user identity');
             return;
        }
        const hasPermission = await checkUserPermission(user.userId, roomName);
        if (!hasPermission) {
            console.warn(`[Auth] User ${user.userId} denied access to room ${roomName}. Closing connection.`);
            ws.close(4003, 'Forbidden');
            return;
        }
        console.log(`[Auth] User ${user.userId} granted access to room ${roomName}.`);

        // --- Yjs Setup (if authorized) ---
        const ydoc = getYDoc(roomName); // Get or create & load the WSSharedDoc
        ydoc.addConnection(ws); // Add connection (sends initial state)

        // Handle messages
        const messageListener = (message) => {
            try {
                const uint8ArrayMsg = (message instanceof Buffer) ? new Uint8Array(message) : message;
                syncProtocol.readSyncMessage(uint8ArrayMsg, ydoc, ws);
                awarenessProtocol.applyAwarenessUpdate(ydoc.awareness, uint8ArrayMsg, ws);
            } catch (error) {
                console.error('[Manual Yjs] Error processing message:', error);
                ws.close(1011, 'Message processing error');
            }
        };
        ws.on('message', messageListener);

        // Handle close
        const closeListener = () => {
            console.log(`[Manual Yjs] Client disconnected from room: ${roomName} (User: ${user?.userId})`);
            ydoc.removeConnection(ws);
        };
        ws.on('close', closeListener);

        // Handle error
        ws.on('error', (error) => {
            console.error(`[Manual Yjs] WebSocket error for room ${roomName} (User: ${user?.userId}):`, error);
            ydoc.removeConnection(ws);
            // Don't necessarily close here again, 'close' event should fire anyway
        });

        console.log(`[Manual Yjs] Client connection fully setup for room: ${roomName} (User: ${user?.userId})`);

    } catch (error) {
        console.error('[Manual Yjs] Unexpected error during connection setup:', error);
        ws.close(1011, 'Internal server error during connection setup');
    }
});

// --- Placeholder for Authorization Logic ---
async function checkUserPermission(userId, projectId) {
    console.log(`[Auth Check] Checking if user ${userId} can access project ${projectId}`);
    // !!! REPLACE WITH YOUR ACTUAL DATABASE LOGIC !!!
    // Example: Check if project exists and user is member/owner
    // const project = await ProjectModel.findOne({ _id: projectId, members: userId });
    // return !!project; // Return true if project found and user is member
    return true; // TEMPORARY: Allow all access for testing
}


// --- Initialize Existing Socket.IO Server (io) --- (Optional)
const io = new Server(server, { cors: corsOptions });
console.log('[Socket.IO] Server initialized (for non-Yjs features).');
io.on('connection', (socket) => {
    // ... (keep if needed for other features, remove 'codeChange' handler) ...
});

// --- API Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode"));

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[Server] HTTP & WebSocket server running on port ${PORT}`));