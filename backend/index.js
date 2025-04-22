require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const WebSocket = require('ws'); // <-- Import WebSocket library
const { setupWSConnection } = require('y-websocket/bin/utils'); // <-- Import Yjs utility
const connectDB = require('./config/db');

// --- CORS Configuration ---
// Define allowed origins for both HTTP CORS and Socket.IO/WebSocket CORS
const allowedOrigins = [
    'https://unicode-two.vercel.app', // Your frontend deployment
    'http://localhost:3000',        // Common local dev ports
    'http://localhost:5173',
    // Add any other origins you need to allow
];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests) or if origin is allowed
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            callback(new Error(msg), false);
        }
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true // If you might need cookies/auth headers later
};

const app = express();
app.use(cors(corsOptions)); // Use configured CORS for HTTP requests
app.use(express.json());

// --- Database Connection ---
connectDB();

// --- HTTP Server Setup ---
const server = http.createServer(app); // Create HTTP server from Express app

// --- Initialize Yjs WebSocket Server (wss) ---
const wss = new WebSocket.Server({
    server // Attach Yjs WebSocket server to the SAME http server
});

console.log('[Yjs Server] WebSocket server initialized and attached to HTTP server.');

// --- Handle Yjs WebSocket Connections ---
wss.on('connection', (ws, req) => {
    // req: IncomingMessage - contains headers, url etc. Can be used for auth later.
    // ws: WebSocket instance for the connected client.
    console.log('[Yjs Server] Client attempting WebSocket connection...');

    // Use the y-websocket utility to handle Yjs protocol syncing for this connection
    // It internally associates clients based on the 'room' derived from the connection URL path
    // (e.g., ws://yourserver.com/projectId - y-websocket extracts 'projectId')
    // Ensure your frontend WebsocketProvider connects like: new WebsocketProvider('ws://...', projectId, ydoc)
    try {
        setupWSConnection(ws, req);
        console.log(`[Yjs Server] Connection established & setup for client. URL: ${req.url}`);
    } catch (error) {
        console.error(`[Yjs Server] Failed to setup Yjs connection: ${error.message}`);
        ws.close(); // Close connection if setup fails
    }

    // Optional: Handle ws errors and closes specifically if needed
    ws.on('error', (error) => {
      console.error('[Yjs Server] WebSocket error:', error);
    });
    ws.on('close', (code, reason) => {
      // Reason might not always be available depending on client/network
      const reasonString = reason ? reason.toString() : 'No reason given';
      console.log(`[Yjs Server] WebSocket closed. Code: ${code}, Reason: ${reasonString}`);
      // Cleanup related to this specific ws connection might happen here if using custom persistence/auth
    });
});


// --- Initialize Existing Socket.IO Server (io) ---
// You might keep this for other real-time features NOT handled by Yjs (e.g., presence, chat)
// IMPORTANT: Restrict CORS origin here as well!
const io = new Server(server, {
    cors: corsOptions // Use the same CORS options as Express
});

console.log('[Socket.IO] Server initialized and attached to HTTP server.');

// --- Handle Regular Socket.IO Connections ---
io.on('connection', (socket) => {
    console.log(`[Socket.IO] User connected: ${socket.id}`);

    // Keep for logging or potential non-Yjs features. Yjs manages its own rooms.
    socket.on('joinProject', ({ projectId }) => {
        if (projectId) {
             console.log(`[Socket.IO] User ${socket.id} joining project room (for non-Yjs events): ${projectId}`);
             socket.join(projectId); // Join Socket.IO room
        } else {
            console.warn(`[Socket.IO] User ${socket.id} tried to join project with invalid projectId.`);
        }
    });

    // --- THIS IS NOW HANDLED BY Yjs ---
    // Commented out to prevent duplicate/conflicting code updates
    /*
    socket.on('codeChange', ({ projectId, code }) => {
        console.log(`[Socket.IO] Received codeChange (DEPRECATED) from ${socket.id} for ${projectId}`);
        // Broadcasting full code via Socket.IO is replaced by Yjs delta updates via ws
        // io.to(projectId).emit('codeChange', { code });
    });
    */

    socket.on('disconnect', (reason) => {
        console.log(`[Socket.IO] User disconnected: ${socket.id}. Reason: ${reason}`);
    });
});

// --- API Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use("/api", require("./routes/runCode"));

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[Server] HTTP & WebSocket server running on port ${PORT}`));

// Optional: Export server if needed by tests or other scripts
// module.exports = server;