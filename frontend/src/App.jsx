import React, { useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { io } from 'socket.io-client';

// Connect to the backend server
const socket = io('http://localhost:3001');

function App() {
  const [code, setCode] = useState('// Start coding here...');
  const editorRef = useRef(null);

  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
  };

  const handleEditorChange = (value, event) => {
    setCode(value);
    socket.emit('codeChange', { code: value });
  };

  useEffect(() => {
    // Listen for incoming code changes from other users
    socket.on('codeChange', (data) => {
      setCode(data.code);
    });

    return () => {
      socket.off('codeChange');
    };
  }, []);

  return (
    <div className="h-screen bg-gray-100">
      <header className="p-4 bg-blue-600 text-white text-center">
        <h1 className="text-2xl">Collaborative Code Editor</h1>
      </header>
      <div className="p-4">
        <Editor
          height="80vh"
          defaultLanguage="javascript"
          value={code}
          onMount={handleEditorDidMount}
          onChange={handleEditorChange}
          theme="vs-dark"
        />
      </div>
    </div>
  );
}

export default App;
