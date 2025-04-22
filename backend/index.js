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

// --- Persistence Functions ---

// Debounced save function map (to avoid saving too frequently)
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
         // ... (same awareness broadcasting logic as before) ...
         const changedClients = added.concat(updated, removed);
         if (conn !== null) { /* handle connControlledIDs */ }
         const encoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
         const message = awarenessProtocol.encodeAwarenessMessage(encoder);
         this.conns.forEach((_, c) => { /* send message */ });
     }

     _updateHandler(update, origin) {
         // ... (same document update broadcasting logic as before) ...
         const encoder = syncProtocol.writeUpdate(update);
         const message = syncProtocol.encodeSyncMessage(encoder);
         this.conns.forEach((_, conn) => { /* send message if conn !== origin */ });
     }

    addConnection(conn) {
        // ... (same logic as before: add to this.conns, send sync step 1, send awareness) ...
         this.conns.set(conn, new Set());
         const encoder = syncProtocol.writeSyncStep1(this);
         conn.send(syncProtocol.encodeSyncMessage(encoder));
         if (this.awareness.getStates().size > 0) { /* send awareness update */ }
    }

    removeConnection(conn) {
        // ... (same logic as before: remove from awareness, delete from this.conns) ...
         const controlledIds = this.conns.get(conn);
         this.conns.delete(conn);
         if (controlledIds) { /* remove awareness states */ }

        // Persistence Logic (Save on last disconnect - optional if using debounced save)
        // if (this.conns.size === 0) {
        //    console.log(`[Persistence] Last client disconnected from ${this.name}. Triggering final save.`);
        //    saveYDoc(this); // Ensure final save happens immediately
        //    // Optional: Clear from memory if persistence is reliable
        //    // docs.delete(this.name);
        // }
    }
}

// --- Modified getYDoc to Load from DB ---
const getYDoc = (docname, gc = true) => map.setIfUndefined(docs, docname, () => {
    const doc = new WSSharedDoc(docname); // Use custom class
    console.log(`[Manual Yjs] Trying to load or create doc for room: ${docname}`);

    // ** Load document state from database **
    YjsDocModel.findOne({ name: docname }).then(dbDoc => {
        if (dbDoc && dbDoc.data) {
            console.log(`[Persistence] Found existing doc in DB for room: ${docname}. Applying update.`);
            // Apply the saved state as an update to the new Y.Doc
            Y.applyUpdate(doc, dbDoc.data);
        } else {
            console.log(`[Persistence] No existing doc found in DB for room: ${docname}. Starting fresh.`);
            // Optionally populate with default content if needed
            // doc.getText('monaco').insert(0, '// Start coding here');
        }
         // Trigger initial save after loading/creating (starts debounce timer)
         saveYDoc(doc);
    }).catch(err => {
        console.error(`[Persistence] Error loading document for room ${docname}:`, err);
        // Decide how to handle loading errors - start fresh or close connection?
    });

    docs.set(docname, doc);
    return doc;
});




// --- Express App Setup ---
const app = express();
app.use(cors());
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
        const token = parsedUrl.searchParams.get('token'); // Get JWT from ?token=... query param

        if (!token) {
            console.warn('[Auth] No token provided. Closing connection.');
            ws.close(4001, 'Unauthorized: No token');
            return;
        }

        try {
            // Verify the token (replace with your actual verification logic)
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            user = decoded; // Store decoded payload (e.g., { userId: '...' })
            console.log(`[Auth] Token verified successfully for user ID: ${user.userId || 'N/A'}`);
        } catch (err) {
            console.warn(`[Auth] Invalid token: ${err.message}. Closing connection.`);
            ws.close(4002, 'Unauthorized: Invalid token');
            return;
        }

        // Determine room name (e.g., from path /projectId)
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        if (pathSegments.length > 0) {
            roomName = pathSegments[0];
        } else {
             console.warn(`[Manual Yjs] Could not derive room name from URL: ${req.url}. Using default.`);
            // Potentially close connection if room is mandatory
            // ws.close(1011, 'Cannot determine room'); return;
        }
        console.log(`[Manual Yjs] Client trying to access room: ${roomName}`);

        // --- Authorization ---
        // ** TODO: Replace with your actual permission check **
        // Check if 'user' has permission to access 'roomName' (projectId)
        const hasPermission = await checkUserPermission(user.userId, roomName); // Assume this function exists
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
        const messageListener = (message) => { /* ... same message handling as before ... */ };
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
            ws.close(1011, 'WebSocket error');
        });

        console.log(`[Manual Yjs] Client connection fully setup for room: ${roomName} (User: ${user?.userId})`);

    } catch (error) {
        // Catch any unexpected errors during connection setup
        console.error('[Manual Yjs] Unexpected error during connection setup:', error);
        ws.close(1011, 'Internal server error during connection setup');
    }
});

// --- Placeholder for Authorization Logic ---
// Replace this with your actual logic to check user permissions for a project
async function checkUserPermission(userId, projectId) {
    console.log(`[Auth Check] Checking if user ${userId} can access project ${projectId}`);
    // Example: Look up user and project in your database
    // const user = await User.findById(userId);
    // const project = await Project.findById(projectId);
    // if (user && project && project.allowedUsers.includes(userId)) { return true; }
    // For now, allow everyone for testing (REMOVE THIS IN PRODUCTION)
    return true;
}


// --- Initialize Existing Socket.IO Server (io) --- (Optional)
// ... (same as before, keep if needed for other features) ...

// --- API Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode"));

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[Server] HTTP & WebSocket server running on port ${PORT}`));