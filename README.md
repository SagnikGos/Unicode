# Collaborative Code Editor

## Overview
This is a real-time collaborative code editor inspired by Google Docs, allowing multiple users to work together on the same project seamlessly.

## Features
- **Real-time Collaboration**: Users can edit code simultaneously, with updates reflecting instantly.
- **Project-Based Access**: Users join projects using a project ID and password.
- **Secure Authentication**: User login and project authentication ensure controlled access.
- **Code Execution**: Run code in multiple languages using the Judge0 API.
- **VS Code-Like Interface**: Uses Monaco Editor for an intuitive coding experience.
- **Progress Persistence**: Code changes are stored in MongoDB for continuity.
- **Web-Based**: No installations needed—just open the editor in a browser.

## Tech Stack
### **Frontend**
- React.js (Vite)
- Monaco Editor
- Tailwind CSS
- Socket.io (for real-time updates)

### **Backend**
- Node.js with Express.js
- MongoDB (for storing projects and user data)
- Socket.io (for handling real-time communication)
- Judge0 API (for code execution)

## Future Enhancements
- **GitHub Integration** for saving and retrieving code.
- **Live Chat** for better collaboration.
- **Multi-File Support** to handle complete projects.
- **Terminal Access** for real-time command execution.

Stay tuned for more updates!

