// --- Backend server file (e.g., index.js) ---
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io'); // Renamed to avoid conflict
const WebSocket = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const map = require('lib0/map'); // Although map is imported, it's not directly used here. It's likely used internally by y-protocols.
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const url = require('url'); // Needed for parsing URL in upgrade handler
const connectDB = require('./config/db');

const Project = require('./models/project'); // Assuming this model exists and has a relevant structure

// --- Persistence Setup ---
const YjsDocSchema = new mongoose.Schema({
    name: { type: String, required: true, index: true, unique: true }, // Ensure name is unique
    data: { type: Buffer, required: true },
}, { timestamps: true });
const YjsDocModel = mongoose.model('YjsDoc', YjsDocSchema);
console.log('[Persistence] Mongoose model for YjsDoc registered.');

const docs = new Map(); // In-memory cache for active Y.Doc objects
const debouncedSave = new Map(); // Map to store debounce timers for saving
const debounceTimeout = 5000; // Save documents 5 seconds after the last change

// Debounced function to save Yjs document state to MongoDB
const saveYDoc = async (doc) => {
    const roomName = doc.name;
    if (debouncedSave.has(roomName)) {
        clearTimeout(debouncedSave.get(roomName));
    }
    debouncedSave.set(roomName, setTimeout(async () => {
        console.log(`[Persistence] Debounced save triggered for room: ${roomName}`);
        try {
            // Encode the entire document state as an update
            const dataToSave = Y.encodeStateAsUpdate(doc);
            // Use findOneAndUpdate with upsert:true to create or update the document
            await YjsDocModel.findOneAndUpdate(
                { name: roomName },
                { data: Buffer.from(dataToSave) },
                { upsert: true, new: true, setDefaultsOnInsert: true } // Ensure new doc defaults are set if created
            );
            console.log(`[Persistence] Successfully saved doc for room: ${roomName}`);
        } catch (error) {
            console.error(`[Persistence] Error saving document for room ${roomName}:`, error);
        } finally {
            // Clean up the debounce timer entry
            debouncedSave.delete(roomName);
        }
    }, debounceTimeout));
};

// --- Yjs Document Class with WebSocket Handling ---
class WSSharedDoc extends Y.Doc {
    constructor(name) {
        super({ gc: true }); // Enable garbage collection
        this.name = name; // Typically the project ID or room name
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null); // Initialize local awareness state

        // Map to store WebSocket connections associated with this document
        // key: WebSocket connection, value: Set<clientID> (awareness client IDs controlled by this conn)
        this.conns = new Map();

        // --- Event Listeners ---
        // 1. Listen for document updates
        this.on('update', (update, origin) => {
            this._updateHandler(update, origin);
            // Persist changes after broadcasting
            saveYDoc(this);
        });

        // 2. Listen for awareness updates
        this.awareness.on('update', this._awarenessUpdateHandler.bind(this));
        // Note: Binding `this` is crucial here as the handler method will be called by the Awareness instance

        // Load persisted data when the document is created
        this.loadPersistedData();
    }

    async loadPersistedData() {
        console.log(`[Persistence] Checking DB for existing data for room: ${this.name}`);
        try {
            const dbDoc = await YjsDocModel.findOne({ name: this.name });
            if (dbDoc?.data) {
                console.log(`[Persistence] Found data in DB for room: ${this.name}. Applying update.`);
                // Apply the persisted state as an update to this Y.Doc
                // Use origin 'persistence' to potentially differentiate if needed, though not used here
                Y.applyUpdate(this, dbDoc.data, 'persistence');
            } else {
                console.log(`[Persistence] No data found in DB for room: ${this.name}. Starting fresh.`);
                // Optionally save an initial empty state if needed, though saveYDoc on first update handles this
                // saveYDoc(this); // Might be redundant if first update triggers save anyway
            }
        } catch (err) {
            console.error(`[Persistence] Error loading document for room ${this.name}:`, err);
        }
    }


    // Handler for Awareness updates
    _awarenessUpdateHandler({ added, updated, removed }, connOrigin) {
        const changedClients = added.concat(updated).concat(removed);
        const connControlledIDs = connOrigin ? this.conns.get(connOrigin) : null;

        // Update the set of clientIDs controlled by the connection that originated the update
        if (connOrigin && connControlledIDs) {
            added.forEach(clientID => { connControlledIDs.add(clientID); });
            removed.forEach(clientID => { connControlledIDs.delete(clientID); });
        } else if (!connOrigin) {
            // If connOrigin is null (e.g., server-side change), log it or handle appropriately
            // console.log(`[Awareness ${this.name}] Update originated internally or from unknown source.`);
        }


        // Encode the awareness update for the changed clients
        const encoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
        // Create a message containing the awareness update
        const message = syncProtocol.messageAwareness; // Use the correct message type constant
        const buffer = Buffer.concat([Buffer.from([message]), encoder]); // Prepend message type

        // Broadcast the awareness update to all connected clients except the originator
        this.conns.forEach((controlledIDs, conn) => {
            if (conn !== connOrigin) { // Don't send back to the originator
                try {
                    conn.send(buffer);
                } catch (e) {
                    console.error(`[Awareness ${this.name}] Error sending awareness update to a connection:`, e);
                    // Attempt to close the problematic connection
                    this.removeConnection(conn);
                }
            }
        });
    }

    // Handler for Y.Doc updates
    _updateHandler(update, origin) {
        // Encode the document update
        const encoder = syncProtocol.writeUpdate(update);
        // Create a message containing the sync update (SyncStep2 or Update)
        // The protocol differentiates based on the encoder type, but we use messageSync
        const message = syncProtocol.messageSync; // Use the correct message type constant
        const buffer = Buffer.concat([Buffer.from([message]), encoder]); // Prepend message type

        // Broadcast the update to all connected clients except the originator
        this.conns.forEach((controlledIDs, conn) => {
            if (conn !== origin) { // Don't send back to the originator
                try {
                    conn.send(buffer);
                } catch (e) {
                    console.error(`[Sync ${this.name}] Error sending document update to a connection:`, e);
                    // Attempt to close the problematic connection
                    this.removeConnection(conn);
                }
            }
        });
    }

    // Add a new WebSocket connection to this document's management
    addConnection(conn, userId) { // Pass userId for logging/awareness setup
        console.log(`[WSSharedDoc ${this.name}] Adding connection for user: ${userId}`);
        this.conns.set(conn, new Set()); // Initialize the set of controlled clientIDs for this connection

        // --- Sync Protocol: Step 1 ---
        // Send the current state of the document to the new client
        console.log(`[WSSharedDoc ${this.name}] Preparing SyncStep1...`);
        const syncEncoder = syncProtocol.writeSyncStep1(this);
        const syncMessage = syncProtocol.messageSync; // Use the correct message type constant
        const syncBuffer = Buffer.concat([Buffer.from([syncMessage]), syncEncoder]); // Prepend message type

        try {
            console.log(`[WSSharedDoc ${this.name}] Sending SyncStep1...`);
            conn.send(syncBuffer);
        } catch (e) {
            console.error(`[WSSharedDoc ${this.name}] Error sending SyncStep1:`, e);
            this.removeConnection(conn); // Clean up immediately if sending fails
            return; // Stop further processing for this connection
        }
        console.log(`[WSSharedDoc ${this.name}] SyncStep1 sent.`);

        // --- Awareness Protocol ---
        // Send the current awareness state of all other users to the new client
        const awarenessStates = this.awareness.getStates();
        if (awarenessStates.size > 0) {
             console.log(`[WSSharedDoc ${this.name}] Preparing initial Awareness state...`);
            const awarenessEncoder = awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys()));
            const awarenessMessage = syncProtocol.messageAwareness; // Use the correct message type constant
            const awarenessBuffer = Buffer.concat([Buffer.from([awarenessMessage]), awarenessEncoder]); // Prepend message type
            try {
                 console.log(`[WSSharedDoc ${this.name}] Sending initial Awareness state...`);
                conn.send(awarenessBuffer);
                 console.log(`[WSSharedDoc ${this.name}] Initial Awareness state sent.`);
            } catch (e) {
                console.error(`[WSSharedDoc ${this.name}] Error sending initial Awareness state:`, e);
                // Don't necessarily disconnect here, sync might have worked, but log the error.
            }
        } else {
             console.log(`[WSSharedDoc ${this.name}] No existing awareness states to send.`);
        }

        console.log(`[WSSharedDoc ${this.name}] Connection added and initialized for user: ${userId}`);
    }

    // Remove a WebSocket connection
    removeConnection(conn) {
        if (this.conns.has(conn)) {
            console.log(`[WSSharedDoc ${this.name}] Removing connection...`);
            const controlledIds = this.conns.get(conn);
            this.conns.delete(conn);

            // Remove awareness states associated with the disconnected connection
            if (controlledIds && controlledIds.size > 0) {
                 console.log(`[WSSharedDoc ${this.name}] Removing awareness states for clientIDs: ${Array.from(controlledIds).join(', ')}`);
                awarenessProtocol.removeAwarenessStates(
                    this.awareness,
                    Array.from(controlledIds),
                    'disconnect' // Origin description
                );
            }
             console.log(`[WSSharedDoc ${this.name}] Connection removed. Remaining connections: ${this.conns.size}`);

             // If no connections left, consider persisting immediately or other cleanup
             if (this.conns.size === 0) {
                 console.log(`[WSSharedDoc ${this.name}] Last connection closed. Document instance remains in memory.`);
                 // Optional: Trigger a final save if needed, though debounced save might cover it.
                 // saveYDoc(this); // Could potentially force a save if needed
             }

        } else {
             console.warn(`[WSSharedDoc ${this.name}] Attempted to remove a connection that was not registered.`);
        }
        // Ensure the WebSocket is properly closed from the server side if not already
        if (conn && conn.readyState !== WebSocket.CLOSED && conn.readyState !== WebSocket.CLOSING) {
            conn.close();
        }
    }
}

// --- Document Management ---
// Function to get or create a WSSharedDoc instance
const getYDoc = (docname) => {
    let doc = docs.get(docname);
    if (doc === undefined) {
        console.log(`[Manual Yjs] Creating NEW doc instance in memory for room: ${docname}`);
        doc = new WSSharedDoc(docname); // This constructor now handles loading data
        docs.set(docname, doc);
        // Loading logic is moved inside WSSharedDoc constructor
    } else {
        console.log(`[Manual Yjs] Reusing EXISTING doc instance from memory for room: ${docname}`);
    }
    // console.log(`[getYDoc] Returning doc for room ${docname}. Has addConnection method? ${typeof doc?.addConnection === 'function'}`);
    return doc;
};

// --- Server Setup ---
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS ? process.env.CORS_ALLOWED_ORIGINS.split(',') : ['http://localhost:3000', "https://unicode-two.vercel.app"]; // Default for local dev
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
};


const app = express();
app.use(cors(corsOptions));
app.use(express.json());

// --- Database Connection ---
connectDB();

// --- HTTP Server ---
const server = http.createServer(app);

// --- WebSocket Server ---
const wss = new WebSocket.Server({ noServer: true }); // We'll handle the upgrade manually
console.log('[Manual Yjs] WebSocket server initialized (manual upgrade).');

// --- WebSocket Upgrade Handling & Authentication ---
server.on('upgrade', async (request, socket, head) => {
    console.log('[Upgrade] Received upgrade request.');
    let S
    let userId;
    let projectId; // This will be our roomName

    try {
        const parsedUrl = url.parse(request.url, true);
        const token = parsedUrl.query.token;
        projectId = parsedUrl.query.projectId; // Use projectId as the room identifier

        if (!token || !projectId) {
            console.error('[Upgrade] Failed: Missing token or projectId in query parameters.');
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); // Send error response
            socket.destroy();
            return;
        }

        // 1. Verify JWT Token
        console.log(`[Upgrade] Attempting to verify token for projectId: ${projectId}`);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.userId; // Assumes your JWT payload has userId
        console.log(`[Upgrade] Token verified for userId: ${userId}`);

        // 2. Check User Permissions
        console.log(`[Upgrade] Checking permissions for userId: ${userId} on projectId: ${projectId}`);
        const hasPermission = await checkUserPermission(userId, projectId);
        if (!hasPermission) {
            console.error(`[Upgrade] Failed: User ${userId} does not have permission for project ${projectId}.`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); // Send forbidden response
            socket.destroy();
            return;
        }
        console.log(`[Upgrade] Permission granted for userId: ${userId} on projectId: ${projectId}`);

        // 3. Handshake with WebSocket Server
        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log(`[Upgrade] WebSocket handshake successful for projectId: ${projectId}`);
            // Attach metadata to the WebSocket connection object BEFORE emitting 'connection'
            ws.roomId = projectId; // Consistent naming with connection handler
            ws.userId = userId;
            wss.emit('connection', ws, request); // Pass request for potential future use
        });

    } catch (error) {
        console.error('[Upgrade] Failed during upgrade process:', error.message);
         // Handle specific errors (e.g., JWT expiration)
        if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
             socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        } else {
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        }
        socket.destroy();
    }
});

// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => {
    // Retrieve metadata attached during upgrade
    const roomName = ws.roomId; // Use the attached roomId
    const userId = ws.userId;   // Use the attached userId

    // Basic check to ensure metadata is present (should always be if upgrade succeeded)
    if (!roomName || !userId) {
         console.error(`[Connection] Internal Error: Missing roomId or userId on WebSocket object after upgrade. Closing connection.`);
         ws.close(1011, 'Internal Server Error: Connection metadata missing.');
         return;
    }

    console.log(`[Manual Yjs] Verified client connected. User: ${userId}, Room: ${roomName}`);

    try {
        const ydoc = getYDoc(roomName); // Get or create the WSSharedDoc instance

        // Check if ydoc is valid (it should be an instance of WSSharedDoc)
        if (!(ydoc instanceof WSSharedDoc) || typeof ydoc.addConnection !== 'function') {
             console.error(`[Manual Yjs] Failed to get valid ydoc instance for room ${roomName}. Type: ${typeof ydoc}. Closing connection.`);
             ws.close(1011, 'Internal Server Error: Document initialization failed');
             return;
        }

        // Add the connection to the document's management
        ydoc.addConnection(ws, userId); // Pass userId for context

        // --- WebSocket Message Listener ---
        const messageListener = (messageBuffer) => {
             // console.log(`[Manual Yjs ${roomName}] Received message from user: ${userId}`);
             try {
                 // Process message using y-protocols
                 // messageBuffer should be a Buffer or ArrayBuffer
                 const message = Buffer.from(messageBuffer); // Ensure it's a Buffer
                 const messageType = message[0]; // First byte indicates message type

                 switch (messageType) {
                     case syncProtocol.messageSync:
                         // Handle SyncStep1, SyncStep2, or Update messages
                         syncProtocol.readSyncMessage(message.slice(1), Y.encodeStateVector(ydoc), ydoc, ws);
                         break;
                     case syncProtocol.messageAwareness:
                         // Handle Awareness update messages
                         awarenessProtocol.applyAwarenessUpdate(ydoc.awareness, message.slice(1), ws);
                         break;
                     default:
                         console.warn(`[Manual Yjs ${roomName}] Received unknown message type: ${messageType} from user: ${userId}`);
                 }
             } catch (error) {
                 console.error(`[Manual Yjs ${roomName}] Error processing message from user ${userId}:`, error);
                 // Optionally close the connection if messages are malformed
                 // ws.close(1003, 'Unsupported data format');
                 ydoc.removeConnection(ws); // Clean up connection state in the doc
             }
        };
        ws.on('message', messageListener);

        // --- WebSocket Close Listener ---
        const closeListener = (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'No reason given';
            console.log(`[Manual Yjs ${roomName}] Connection closed for user: ${userId}. Code: ${code}, Reason: ${reasonStr}`);
            // Get the document again (it should still be in memory if active)
            const doc = getYDoc(roomName); // Use getYDoc to ensure we get the cached instance
             if (doc instanceof WSSharedDoc) {
                 doc.removeConnection(ws); // Clean up the connection within the WSSharedDoc instance
             } else {
                 console.error(`[Manual Yjs ${roomName}] Could not find valid doc instance on close for user: ${userId}`);
             }
        };
        ws.on('close', closeListener);

        // --- WebSocket Error Listener ---
        const errorListener = (error) => {
            console.error(`[Manual Yjs ${roomName}] WebSocket error for user ${userId}:`, error);
            // The 'close' event will usually follow an error, so cleanup happens there.
            // However, we can ensure cleanup happens here too.
            const doc = getYDoc(roomName);
            if (doc instanceof WSSharedDoc) {
                doc.removeConnection(ws); // Ensure cleanup even if close event doesn't fire reliably after error
            }
        };
        ws.on('error', errorListener);

        console.log(`[Manual Yjs] Client connection fully setup for room: ${roomName} (User: ${userId})`);

    } catch (error) {
        console.error(`[Manual Yjs] Unexpected error during connection setup (post-upgrade) for room ${roomName}, user ${userId}:`, error);
        // Ensure the socket is closed if an error occurs during setup
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
             ws.close(1011, 'Internal server error during connection setup');
        }
    }
});

// --- Permission Checking Function ---
// This is a placeholder. Replace with your actual permission logic.
async function checkUserPermission(userId, projectId) {
    console.log(`[Permissions] Checking if user ${userId} can access project ${projectId}`);
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(projectId)) {
        console.warn(`[Permissions] Invalid userId (${userId}) or projectId (${projectId}) format.`);
        return false;
    }
    try {
        const project = await Project.findById(projectId).select('members owner'); // Adjust fields as needed
        if (!project) {
            console.log(`[Permissions] Project ${projectId} not found.`);
            return false; // Project doesn't exist
        }

        // Example: Check if the user is the owner or in the members array
        // Adjust this logic based on your actual Project schema structure
        const isOwner = project.owner && project.owner.toString() === userId;
        const isMember = project.members && project.members.some(memberId => memberId.toString() === userId);

        if (isOwner || isMember) {
             console.log(`[Permissions] Access granted for user ${userId} to project ${projectId}.`);
            return true;
        } else {
             console.log(`[Permissions] Access denied for user ${userId} to project ${projectId}. Not owner or member.`);
            return false;
        }
    } catch (error) {
        console.error(`[Permissions] Error checking permissions for user ${userId} on project ${projectId}:`, error);
        return false; // Deny access on error
    }
}

// --- Socket.IO Server (if still needed for other purposes) ---
// Note: This Socket.IO instance is separate from the 'ws' WebSocket server used for Yjs.
// If Yjs is the primary real-time mechanism, you might not need Socket.IO.
const io = new SocketIOServer(server, { cors: corsOptions });

// Example Socket.IO connection handler (if used)
io.on('connection', (socket) => {
    console.log('[Socket.IO] User connected:', socket.id);
    // Add Socket.IO specific event handlers here if needed
    socket.on('disconnect', () => {
        console.log('[Socket.IO] User disconnected:', socket.id);
    });
});

// --- Express Routes ---
app.get('/', (req, res) => { // Basic health check / root route
    res.send('Collaboration Server is running.');
});
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode")); // Assuming this handles code execution requests

// --- Start Server ---
const PORT = process.env.PORT || 3001;
// Listen on 0.0.0.0 to accept connections from any network interface (important for Docker/deployment)
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}, accepting connections from all interfaces.`));