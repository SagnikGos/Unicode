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
const map = require('lib0/map'); // Although setIfUndefined isn't used in the new getYDoc, map might be useful elsewhere
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

    addConnection(conn) {
        this.conns.set(conn, new Set());
        const syncEncoder = syncProtocol.writeSyncStep1(this);
        try { conn.send(syncProtocol.encodeSyncMessage(syncEncoder)); } catch (e) { conn.close();}
        if (this.awareness.getStates().size > 0) {
            const awarenessEncoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys()));
             try { conn.send(awarenessProtocol.encodeAwarenessMessage(awarenessEncoder)); } catch (e) { conn.close(); }
        }
    }

    removeConnection(conn) {
        const controlledIds = this.conns.get(conn);
        this.conns.delete(conn);
        if (controlledIds) {
            awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(controlledIds), null);
        }
        // Optional: Trigger immediate save on last disconnect if desired
        // if (this.conns.size === 0) { saveYDoc(this); }
    }
}
// --- End WSSharedDoc Class ---


// --- *** UPDATED getYDoc Function *** ---
const getYDoc = (docname, gc = true) => {
    let doc = docs.get(docname); // Try to get existing doc from the Map first

    if (doc === undefined) { // If no doc instance exists in memory for this room name...
        // Create a new instance of our custom class
        doc = new WSSharedDoc(docname);
        console.log(`[Manual Yjs] Created NEW doc instance in memory for room: ${docname}`);
        // Store the new instance in the map immediately
        docs.set(docname, doc);

        // Asynchronously load data from DB into this new instance
        console.log(`[Persistence] Checking DB for existing data for room: ${docname}`);
        YjsDocModel.findOne({ name: docname }).then(dbDoc => {
            if (dbDoc?.data) {
                // Found data - apply it to the existing 'doc' instance
                console.log(`[Persistence] Found data in DB for room: ${docname}. Applying update.`);
                Y.applyUpdate(doc, dbDoc.data); // Apply to the instance we already created/stored
            } else {
                console.log(`[Persistence] No data found in DB for room: ${docname}. Starting fresh.`);
                // Optional: Apply initial content if needed for brand new docs
                 // doc.getText('monaco').insert(0, '// Welcome!');
            }
            // Trigger the debounced save now that we've loaded/confirmed initial state
             saveYDoc(doc);
        }).catch(err => {
            console.error(`[Persistence] Error loading document for room ${docname}:`, err);
            // Maybe handle error? For now, doc remains empty or with previously loaded data.
        });

    } else {
         // Doc instance already exists in memory, reuse it
         console.log(`[Manual Yjs] Reusing EXISTING doc instance from memory for room: ${docname}`);
    }

    // --- DEBUG LOG ---
    // Check if the object we are about to return has the addConnection method
    console.log(`[getYDoc] Returning doc for room ${docname}. Has addConnection method? ${typeof doc?.addConnection === 'function'}`);

    // Return the doc instance (either newly created or the existing one)
    return doc;
};
// --- *** End UPDATED getYDoc Function *** ---


// --- CORS Configuration ---
const allowedOrigins = [
    'https://unicode-two.vercel.app', // Your frontend deployment
    'http://localhost:3000',        // Common local dev ports
    'http://localhost:5173',        // Vite default port
];
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
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
const wss = new WebSocket.Server({ noServer: true });
console.log('[Manual Yjs] WebSocket server initialized (manual upgrade).');

// --- Handle HTTP Server Upgrade Requests ---
server.on('upgrade', (request, socket, head) => {
    // Perform authentication and authorization before upgrading connection
    try {
        const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
        const roomName = parsedUrl.pathname.split('/').filter(Boolean)[0];
        const token = parsedUrl.searchParams.get('token');

        // Basic validation for roomName and token
        if (!roomName || !token) {
             const reason = !roomName ? 'Room name missing' : 'No token';
             console.warn(`[Auth Upgrade] ${reason} on upgrade request. Destroying socket.`);
             const status = !roomName ? '400 Bad Request' : '401 Unauthorized';
             socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
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

            // Authorization Check
            const userId = decoded.id;
            const hasPermission = await checkUserPermission(userId, roomName);

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
    const roomName = ws.roomId || 'default-room';
    const userId = ws.userId || 'unknown';

    console.log(`[Manual Yjs] Verified client connected to room: ${roomName} (User: ${userId})`);

    try {
        // --- Yjs Setup ---
        const ydoc = getYDoc(roomName); // Get or create & load the WSSharedDoc

        // *** Add a check here to ensure ydoc is valid before proceeding ***
        if (!ydoc || typeof ydoc.addConnection !== 'function') {
             console.error(`[Manual Yjs] Failed to get valid ydoc or ydoc missing methods for room ${roomName}. Closing connection.`);
             ws.close(1011, 'Internal Server Error: Document initialization failed');
             return;
        }

        ydoc.addConnection(ws); // Add connection (sends initial state)

        // Handle messages
        const messageListener = (message) => {
            try {
                const uint8ArrayMsg = (message instanceof Buffer) ? new Uint8Array(message) : message;
                // Pass 'ws' as origin to prevent echo
                syncProtocol.readSyncMessage(uint8ArrayMsg, ydoc, ws);
                awarenessProtocol.applyAwarenessUpdate(ydoc.awareness, uint8ArrayMsg, ws);
            } catch (error) {
                console.error('[Manual Yjs] Error processing message:', error);
                // Optionally close connection on processing error
                // ws.close(1011, 'Message processing error');
            }
        };
        ws.on('message', messageListener);

        // Handle close
        const closeListener = () => {
            console.log(`[Manual Yjs] Client disconnected from room: ${roomName} (User: ${userId})`);
            ydoc.removeConnection(ws); // Use the ydoc instance associated with this connection
            // Clean up listeners for this specific connection
            ws.off('message', messageListener);
            ws.off('close', closeListener);
            ws.off('error', errorListener);
        };
        ws.on('close', closeListener);

        // Handle error
        const errorListener = (error) => {
            console.error(`[Manual Yjs] WebSocket error for room ${roomName} (User: ${userId}):`, error);
            // Ensure connection is removed even if close event doesn't fire cleanly
            ydoc.removeConnection(ws);
            // Clean up listeners
            ws.off('message', messageListener);
            ws.off('close', closeListener);
            ws.off('error', errorListener);
        };
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
        const project = await Project.findOne({ projectId: projectId });
        if (!project) {
            console.log(`[Auth Check] Project not found: ${projectId}`);
            return false;
        }
        const isUserAllowed = project.users.includes(userId);
        if (!isUserAllowed) {
            console.log(`[Auth Check] User ${userId} not found in users array for project ${projectId}`);
        }
        return isUserAllowed;
    } catch (error) {
        console.error(`[Auth Check] Database error during permission check for project ${projectId}:`, error);
        return false;
    }
}
// --- End Authorization Logic Implementation ---


// --- Initialize Existing Socket.IO Server (io) --- (Optional)
const io = new Server(server, { cors: corsOptions });
console.log('[Socket.IO] Server initialized (for non-Yjs features).');
io.on('connection', (socket) => {
    console.log(`[Socket.IO] User connected: ${socket.id}`);
    socket.on('joinProject', ({ projectId }) => { if(projectId) socket.join(projectId); });
    socket.on('disconnect', (reason) => { console.log(`[Socket.IO] User disconnected: ${socket.id}. Reason: ${reason}`); });
});

// --- API Routes ---
app.use('/api/auth', require('./routes/auth')); // Adjust path if needed
app.use('/api/projects', require('./routes/project')); // Adjust path if needed
app.use("/api", require("./routes/runCode")); // Adjust path if needed


// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[Server] HTTP & WebSocket server running on port ${PORT}`));