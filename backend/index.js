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
const Project = require('./models/project'); // Adjust path if needed
// const User = require('./models/User');

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
const debouncedSave = new Map(); // Map<string, NodeJS.Timeout>
const debounceTimeout = 5000; // Save after 5 seconds of inactivity

const saveYDoc = async (doc) => {
    const roomName = doc.name;
    if (debouncedSave.has(roomName)) {
        clearTimeout(debouncedSave.get(roomName));
    }
    debouncedSave.set(roomName, setTimeout(async () => {
        console.log(`[Persistence] Debounced save triggered for room: ${roomName}`);
        try {
            const dataToSave = Y.encodeStateAsUpdate(doc);
            await YjsDocModel.findOneAndUpdate(
                { name: roomName },
                { data: Buffer.from(dataToSave) },
                { upsert: true, new: true }
            );
            console.log(`[Persistence] Successfully saved doc for room: ${roomName}`);
        } catch (error) {
            console.error(`[Persistence] Error saving document for room ${roomName}:`, error);
        } finally {
             debouncedSave.delete(roomName);
        }
    }, debounceTimeout));
};


// --- WSSharedDoc Class (Handles Yjs Doc & Awareness for a room) ---
class WSSharedDoc extends Y.Doc {
    constructor(name) {
        super({ gc: true });
        this.name = name;
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null);
        this.conns = new Map(); // Map<WebSocket, Set<ClientID>>

        this.on('update', (update, origin) => {
            this._updateHandler(update, origin);
            saveYDoc(this); // Debounced save on update
        });
        this.awareness.on('update', this._awarenessUpdateHandler.bind(this));
    }

     _awarenessUpdateHandler({ added, updated, removed }, connOrigin) {
        const changedClients = added.concat(updated).concat(removed);
        const connControlledIDs = connOrigin ? this.conns.get(connOrigin) : null;
        if (connOrigin && connControlledIDs) {
            added.forEach(clientID => { connControlledIDs.add(clientID); });
            removed.forEach(clientID => { connControlledIDs.delete(clientID); });
        }
        const encoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
        const message = awarenessProtocol.encodeAwarenessMessage(encoder);
        this.conns.forEach((controlledIDs, conn) => {
            if (conn !== connOrigin) {
                try { conn.send(message); } catch (e) { console.error("Error sending awareness:", e); conn.close(); }
            }
        });
     }

     _updateHandler(update, origin) {
        const encoder = syncProtocol.writeUpdate(update);
        const message = syncProtocol.encodeSyncMessage(encoder);
        this.conns.forEach((controlledIDs, conn) => {
            if (conn !== origin) {
                try { conn.send(message); } catch (e) { console.error("Error sending update:", e); conn.close(); }
            }
        });
     }

    // --- *** MODIFIED addConnection for Debugging *** ---
    addConnection(conn) {
        console.log(`[WSSharedDoc ${this.name}] Adding connection...`);
        this.conns.set(conn, new Set());

        // --- Send Sync Step 1 ---
        console.log(`[WSSharedDoc ${this.name}] Preparing SyncStep1...`);
        const syncEncoder = syncProtocol.writeSyncStep1(this); // Error originates from here or within this call chain
        try {
             console.log(`[WSSharedDoc ${this.name}] Sending SyncStep1...`);
             conn.send(syncProtocol.encodeSyncMessage(syncEncoder)); // Sends the document state sync
         } catch (e) {
             console.error(`[WSSharedDoc ${this.name}] Error sending SyncStep1:`, e);
             conn.close();
             this.removeConnection(conn); // Clean up if send fails
             return;
         }
        console.log(`[WSSharedDoc ${this.name}] SyncStep1 sent.`);

        // --- **** Temporarily COMMENTED OUT Awareness Sending **** ---
        console.log(`[WSSharedDoc ${this.name}] SKIPPING initial Awareness sending for debugging.`);
        /* <-- Start comment block for debugging
        if (this.awareness.getStates().size > 0) {
            console.log(`[WSSharedDoc ${this.name}] Preparing initial Awareness state...`);
            const awarenessEncoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys()));
             try {
                 console.log(`[WSSharedDoc ${this.name}] Sending initial Awareness state...`);
                 conn.send(awarenessProtocol.encodeAwarenessMessage(awarenessEncoder)); // Sends awareness state
             } catch (e) {
                 console.error(`[WSSharedDoc ${this.name}] Error sending Awareness:`, e);
                 conn.close();
                 this.removeConnection(conn); // Clean up if send fails
                 return;
             }
             console.log(`[WSSharedDoc ${this.name}] Initial Awareness state sent.`);
        } else {
             console.log(`[WSSharedDoc ${this.name}] No initial Awareness states to send.`);
        }
        */ // <-- End comment block for debugging
        // --- **** End Temporarily Commented Out Block **** ---

         console.log(`[WSSharedDoc ${this.name}] Connection added (awareness skipped for test).`);
    }
    // --- *** End MODIFIED addConnection *** ---


    removeConnection(conn) {
        const controlledIds = this.conns.get(conn);
        this.conns.delete(conn);
        if (controlledIds) {
            awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(controlledIds), null);
        }
    }
}
// --- End WSSharedDoc Class ---


// --- UPDATED getYDoc Function ---
const getYDoc = (docname, gc = true) => {
    let doc = docs.get(docname);
    if (doc === undefined) {
        doc = new WSSharedDoc(docname);
        console.log(`[Manual Yjs] Created NEW doc instance in memory for room: ${docname}`);
        docs.set(docname, doc);
        console.log(`[Persistence] Checking DB for existing data for room: ${docname}`);
        YjsDocModel.findOne({ name: docname }).then(dbDoc => {
            if (dbDoc?.data) {
                console.log(`[Persistence] Found data in DB for room: ${docname}. Applying update.`);
                Y.applyUpdate(doc, dbDoc.data);
            } else {
                console.log(`[Persistence] No data found in DB for room: ${docname}. Starting fresh.`);
            }
            saveYDoc(doc);
        }).catch(err => {
            console.error(`[Persistence] Error loading document for room ${docname}:`, err);
        });
    } else {
        console.log(`[Manual Yjs] Reusing EXISTING doc instance from memory for room: ${docname}`);
    }
    console.log(`[getYDoc] Returning doc for room ${docname}. Has addConnection method? ${typeof doc?.addConnection === 'function'}`);
    return doc;
};
// --- End UPDATED getYDoc Function ---


// --- CORS Configuration ---
const allowedOrigins = [ /* ... */ ]; // Make sure your frontend URL is here
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
server.on('upgrade', (request, socket, head) => { /* ... same as before ... */ });

// --- Handle WebSocket Connections ---
wss.on('connection', (ws, req) => {
    const roomName = ws.roomId || 'default-room';
    const userId = ws.userId || 'unknown';
    console.log(`[Manual Yjs] Verified client connected to room: ${roomName} (User: ${userId})`);
    try {
        const ydoc = getYDoc(roomName);
        if (!ydoc || typeof ydoc.addConnection !== 'function') {
             console.error(`[Manual Yjs] Failed to get valid ydoc for room ${roomName}. Closing connection.`);
             ws.close(1011, 'Internal Server Error: Document initialization failed');
             return;
        }
        // Call the modified addConnection (with awareness commented out)
        ydoc.addConnection(ws);

        // Setup message/close/error listeners (same as before)
        const messageListener = (message) => { /* ... */ };
        ws.on('message', messageListener);
        const closeListener = () => { /* ... */ };
        ws.on('close', closeListener);
        const errorListener = (error) => { /* ... */ };
        ws.on('error', errorListener);

        console.log(`[Manual Yjs] Client connection fully setup for room: ${roomName} (User: ${userId}) (Awareness skipped)`);

    } catch (error) {
        console.error(`[Manual Yjs] Unexpected error during connection setup (post-upgrade):`, error);
        ws.close(1011, 'Internal server error during connection setup');
    }
});

// --- Authorization Logic Implementation ---
async function checkUserPermission(userId, projectId) { /* ... same as before ... */ }

// --- Initialize Existing Socket.IO Server (io) --- (Optional)
const io = new Server(server, { cors: corsOptions });
// ... io setup ...

// --- API Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode"));

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`[Server] HTTP & WebSocket server running on host 0.0.0.0, port ${PORT}`));