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

const Project = require('./models/project');

const YjsDocSchema = new mongoose.Schema({
    name: { type: String, required: true, index: true },
    data: { type: Buffer, required: true },
}, { timestamps: true });
const YjsDocModel = mongoose.model('YjsDoc', YjsDocSchema);
console.log('[Persistence] Mongoose model for YjsDoc registered.');

const docs = new Map();
const debouncedSave = new Map();
const debounceTimeout = 5000;

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

class WSSharedDoc extends Y.Doc {
    constructor(name) {
        super({ gc: true });
        this.name = name;
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null);
        this.conns = new Map();

        this.on('update', (update, origin) => {
            this._updateHandler(update, origin);
            saveYDoc(this);
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
        console.log(`[WSSharedDoc ${this.name}] Adding connection...`);
        this.conns.set(conn, new Set());

        console.log(`[WSSharedDoc ${this.name}] Preparing SyncStep1...`);
        const syncEncoder = syncProtocol.writeSyncStep1(this);
        try {
             console.log(`[WSSharedDoc ${this.name}] Sending SyncStep1...`);
             conn.send(syncProtocol.encodeSyncMessage(syncEncoder));
         } catch (e) {
             console.error(`[WSSharedDoc ${this.name}] Error sending SyncStep1:`, e);
             conn.close();
             this.removeConnection(conn);
             return;
         }
        console.log(`[WSSharedDoc ${this.name}] SyncStep1 sent.`);

        console.log(`[WSSharedDoc ${this.name}] SKIPPING initial Awareness sending for debugging.`);
        console.log(`[WSSharedDoc ${this.name}] Connection added (awareness skipped for test).`);
    }

    removeConnection(conn) {
        const controlledIds = this.conns.get(conn);
        this.conns.delete(conn);
        if (controlledIds) {
            awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(controlledIds), null);
        }
    }
}

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

const allowedOrigins = [];
const corsOptions = {};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

connectDB();

const server = http.createServer(app);

const wss = new WebSocket.Server({ noServer: true });
console.log('[Manual Yjs] WebSocket server initialized (manual upgrade).');

server.on('upgrade', (request, socket, head) => { /* ... */ });

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
        ydoc.addConnection(ws);

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

async function checkUserPermission(userId, projectId) { /* ... */ }

const io = new Server(server, { cors: corsOptions });

app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode"));

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));