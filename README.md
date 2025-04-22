# Unicode - Real-Time Collaborative Code Editor

![License](https://img.shields.io/badge/license-MIT-blue.svg) A web application enabling multiple users to edit code documents together in real-time. Built with React, Node.js, Express, MongoDB, Yjs for CRDT-based collaboration, and the Monaco Editor. Includes basic code execution capabilities.

## Features

* **Real-Time Collaboration:** Multiple users can edit the same code document simultaneously, seeing each other's changes and cursors live.
* **Rich Code Editor:** Uses Monaco Editor (the engine behind VS Code) for a powerful editing experience with syntax highlighting, suggestions, etc.
* **User Authentication:** Secure user registration and login using JWT (JSON Web Tokens) and password hashing (bcrypt).
* **Project Management:**
    * Users can create new projects with a user-defined ID/name and a password.
    * Users can join existing projects using the project ID/name and password.
* **Persistence:** Project code state (via Yjs updates) and metadata are persisted in MongoDB.
* **Code Execution:** Basic support for running code snippets written in the editor (JavaScript, Python, C, C++) via a backend API endpoint.
* **Language Selection:** Users can select the language for syntax highlighting and execution.
* **Resizable Output Panel:** View code execution results in a panel that can be resized.

## Tech Stack

**Backend:**

* **Node.js:** JavaScript runtime environment
* **Express:** Web application framework
* **MongoDB:** NoSQL database for storing users, projects, and Yjs document state
* **Mongoose:** Object Data Modeling (ODM) library for MongoDB
* **Yjs:** CRDT library for real-time collaboration state management
* **ws:** WebSocket library for real-time communication (custom server implementation)
* **y-protocols:** Handles Yjs sync and awareness protocols over WebSockets
* **jsonwebtoken (JWT):** For generating and verifying authentication tokens
* **bcryptjs:** For hashing user passwords
* **cors:** For handling Cross-Origin Resource Sharing
* **dotenv:** For managing environment variables

**Frontend:**

* **React:** JavaScript library for building user interfaces
* **react-router-dom:** For client-side routing
* **@monaco-editor/react:** React component for the Monaco Editor
* **yjs:** Client-side Yjs library
* **y-websocket:** Client-side provider for connecting to Yjs WebSocket backend
* **y-monaco:** Binding Yjs to the Monaco Editor model and awareness
* **axios:** For making HTTP requests to the backend API
* **Tailwind CSS:** (Inferred from class names) Utility-first CSS framework

## Getting Started

### Prerequisites

* **Node.js:** Version 18 LTS or later recommended (check `.nvmrc` if present)
* **npm** or **yarn:** Node package manager
* **MongoDB:** A running MongoDB instance (local, Docker, or cloud like MongoDB Atlas)

### Backend Setup

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd <your-repo-name>/backend # Or your backend directory name
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    # or yarn install
    ```
3.  **Set up environment variables:**
    * Copy the example environment file: `cp .env.example .env`
    * Edit the `.env` file with your configuration:
        ```dotenv
        # Port for the backend server
        PORT=3001

        # MongoDB connection string
        DATABASE_URL=mongodb://localhost:27017/unicode_db # Or your MongoDB Atlas string

        # Secret key for signing JWT tokens (choose a strong, random string)
        JWT_SECRET=your_super_secret_jwt_key_here

        # Comma-separated list of allowed frontend origins for CORS
        CORS_ALLOWED_ORIGINS=http://localhost:3000,[https://your-deployed-frontend.com](https://your-deployed-frontend.com)

        # Node environment (development, production)
        NODE_ENV=development
        ```
4.  **Start the backend server:**
    ```bash
    npm start
    # Or for development with nodemon (if configured): npm run dev
    ```
    The server should be running on the specified `PORT`.

### Frontend Setup

1.  **Navigate to the frontend directory:**
    ```bash
    cd ../frontend # Or your frontend directory name (assuming separate folders)
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    # or yarn install
    ```
3.  **Set up environment variables (if needed):**
    * Your frontend might need a `.env` file to specify the backend API/WebSocket URL, especially for production builds. Check for a `.env.example`. Example:
        ```dotenv
        REACT_APP_API_URL=http://localhost:3001
        REACT_APP_WS_URL=ws://localhost:3001
        # For production:
        # REACT_APP_API_URL=[https://unicode-production.up.railway.app](https://unicode-production.up.railway.app)
        # REACT_APP_WS_URL=wss://unicode-production.up.railway.app
        ```
4.  **Start the frontend development server:**
    ```bash
    npm run dev # Or npm start, depending on your setup (e.g., Vite, Create React App)
    ```
    The frontend should be accessible, usually at `http://localhost:3000` or similar.

## Usage Workflow

1.  **Register/Login:** Access the authentication page to create an account or log in.
2.  **Join/Create Project:** After logging in, you'll likely be directed to a page where you can enter a Project ID/Name and Password to either join an existing project or create a new one.
3.  **Collaborate:** Once you join a project, you'll be taken to the editor page (`/editor/<project-database-id>`). Other users who join the same project can edit the code simultaneously.
4.  **Run Code:** Use the "Run Code" button to execute the current code in the selected language via the backend API. Output appears in the panel below.

## Known Issues / TODOs

* Currently investigating a potential low-level issue related to `syncProtocol.writeSyncStep1` in the Yjs library stack (`y-protocols`/`lib0`) within the specific Node.js environment. Collaboration might be unstable until resolved. (See relevant GitHub issues for `y-protocols` or try different Node.js versions if encountering `TypeError` on connection).
* Error handling can be improved on both frontend and backend.
* Add user avatars/names to awareness cursors/selections.
* Implement more robust project access control (e.g., invites instead of just password).
* Expand code execution capabilities/security.
* Add project listing/dashboard page.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue.
_(Optional: Add contribution guidelines)_

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
_(Optional: Create a LICENSE file with the chosen license text)_
