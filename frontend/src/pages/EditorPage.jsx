import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import MonacoEditor from "@monaco-editor/react"; // Default import
import axios from "axios";

// --- Yjs Imports ---
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
// --- End Yjs Imports ---

export default function EditorPage() {
    const { projectId } = useParams();
    // State for non-collaborative parts
    const [language, setLanguage] = useState("javascript");
    const [output, setOutput] = useState("");
    const [isRunning, setIsRunning] = useState(false);
    const [outputType, setOutputType] = useState("success"); // success, error, warning
    const [isConnected, setIsConnected] = useState(false); // Track connection status

    // Refs for editor instance and Yjs artifacts
    const editorRef = useRef(null); // Stores the Monaco editor instance
    const providerRef = useRef(null); // Stores the WebsocketProvider
    const ydocRef = useRef(null); // Stores the Yjs document
    const bindingRef = useRef(null); // Stores the MonacoBinding

    // Ref for UI element
    const outputResizeRef = useRef(null);

    // Callback for when the Monaco Editor instance is mounted
    const handleEditorDidMount = useCallback((editor, monaco) => {
        console.log("[Yjs Client] Editor mounted.");
        editorRef.current = editor; // Store editor instance

        // --- Authentication Token Handling ---
        // !!! Ensure 'token' is the correct key you use in localStorage !!!
        const jwtToken = localStorage.getItem('token');

        if (!jwtToken) {
            console.error("!!! Authentication token not found in localStorage ('token'). WebSocket connection will likely fail or be rejected. !!!");
            // Consider redirecting to login or showing an error message
            // Optionally, set an error state here to inform the user
        } else if (!projectId) {
            console.error("!!! Project ID is missing from URL parameters. Cannot establish WebSocket connection. !!!");
            // Handle missing projectId appropriately, maybe show an error message
        } else {
             console.log("[Yjs Client] Found auth token and projectId. Will attempt connection.");
        }
        // --- End Authentication Token Handling ---

        // Only proceed with Yjs setup if we have the necessary identifiers
        if (projectId && jwtToken) {
            // --- Initialize Yjs ---
            const doc = new Y.Doc(); // Create Yjs doc
            ydocRef.current = doc; // Store ref to doc

            // --- Create WebsocketProvider with BOTH token and projectId in params ---
            const provider = new WebsocketProvider(
                'wss://unicode-production.up.railway.app', // Your backend WebSocket endpoint URL
                projectId,                                // Room name (still required by y-websocket for internal use)
                doc,                                      // Yjs document
                {
                    // Pass connection parameters, BOTH token and projectId
                    params: {
                        token: jwtToken || '',            // Send the retrieved token (fallback to empty string)
                        projectId: projectId              // <<< ADDED projectId HERE
                    },
                    // Only *attempt* connection if BOTH token and projectId exist (redundant with outer check but safe)
                     connect: true // We already checked for jwtToken and projectId وجودهما
                }
            );
            providerRef.current = provider; // Store ref to provider
            // --- End Yjs Initialization ---

            const yText = doc.getText('monaco'); // Get a shared text type named 'monaco'

            // --- Bind Monaco Editor to Yjs ---
            const model = editor.getModel();
            if (model) {
                // Avoid creating multiple bindings if editor re-mounts unexpectedly
                if (bindingRef.current) {
                    bindingRef.current.destroy();
                }
                const binding = new MonacoBinding(
                    yText,                      // The Yjs text type
                    model,                      // Monaco editor model
                    new Set([editor]),          // Set of editor instances to bind
                    provider.awareness          // Yjs awareness for cursor/selection sync
                );
                bindingRef.current = binding; // Store ref to binding
                 console.log("[Yjs Client] Yjs Document, Provider, and MonacoBinding initialized.");
            } else {
                 console.error("[Yjs Client] Monaco Editor model not available for binding.");
            }

            // Log connection status changes and update state
            provider.on('status', event => {
                 console.log(`[Yjs Provider] Status: ${event.status}`);
                 setIsConnected(event.status === 'connected'); // Update React state based on status
            });

            // Initial state check (sometimes status event fires before listener attaches)
            setIsConnected(provider.wsconnected);

        } else {
            console.warn("[Yjs Client] Skipping Yjs/WebSocket setup due to missing token or projectId.");
            // You might want to display a message in the UI indicating connection failure
            setIsConnected(false);
        }

    }, [projectId]); // Re-run setup ONLY if projectId changes

    // Effect for cleanup and non-Yjs setup (like resize)
    useEffect(() => {
        // --- Resizable Output Panel Logic ---
        const resizeableOutput = outputResizeRef.current;
        let startY, startHeight, currentListener = null;

        function startResize(e) {
             startY = e.clientY;
             // Ensure resizeableOutput exists before accessing style
             if (resizeableOutput) {
                 startHeight = parseInt(document.defaultView.getComputedStyle(resizeableOutput).height, 10);
                 document.documentElement.addEventListener('mousemove', resize);
                 document.documentElement.addEventListener('mouseup', stopResize);
                 e.preventDefault();
             }
         }

        function resize(e) {
             const newHeight = startHeight - (e.clientY - startY);
             const minHeight = 50;
             const maxHeight = window.innerHeight * 0.6;
             if (newHeight > minHeight && newHeight < maxHeight && resizeableOutput) {
                  resizeableOutput.style.height = `${newHeight}px`;
             }
         }

        function stopResize() {
             document.documentElement.removeEventListener('mousemove', resize);
             document.documentElement.removeEventListener('mouseup', stopResize);
         }

        const resizeHandle = document.getElementById('resize-handle');
        if (resizeHandle) {
              currentListener = resizeHandle.__resizeListener;
              if (currentListener) {
                   resizeHandle.removeEventListener('mousedown', currentListener);
              }
              resizeHandle.addEventListener('mousedown', startResize);
              resizeHandle.__resizeListener = startResize; // Store listener ref on element to prevent duplicates
         }
        // --- End Resizable Output Panel Logic ---

        // Cleanup function
        return () => {
             console.log("[Yjs Client] Cleanup: Destroying Yjs binding, provider, and doc.");
             bindingRef.current?.destroy();
             providerRef.current?.disconnect();
             providerRef.current?.destroy(); // Ensure provider resources are fully released
             ydocRef.current?.destroy();
             editorRef.current = null; // Clear editor ref

             // Clear refs
             bindingRef.current = null;
             providerRef.current = null;
             ydocRef.current = null;

             // Cleanup resize listeners
             if (resizeHandle && resizeHandle.__resizeListener) {
                 resizeHandle.removeEventListener('mousedown', resizeHandle.__resizeListener);
                 delete resizeHandle.__resizeListener;
             }
             document.documentElement.removeEventListener('mousemove', resize);
             document.documentElement.removeEventListener('mouseup', stopResize);
        };
    }, []); // Empty dependency array for mount/unmount behavior


    // --- Run Code Logic ---
    const runCode = async () => {
        if (!ydocRef.current) {
             console.error("Yjs document not initialized. Cannot run code.");
             setOutput("Error: Editor not ready or connection failed.");
             setOutputType("error");
             return;
        }
        // Get code reliably from Yjs doc text type
        const currentCode = ydocRef.current.getText('monaco').toString();

        setIsRunning(true);
        setOutput("Running code...");
        setOutputType("success");

        try {
             const { data } = await axios.post("https://unicode-production.up.railway.app/api/run", { code: currentCode, language });

             if (data.stderr || data.compile_output) {
                 setOutputType("error");
                 setOutput(data.stderr || data.compile_output);
             } else if (data.stdout !== undefined && data.stdout !== null) { // Check if stdout exists
                 setOutputType("success");
                 setOutput(data.stdout === '' ? '(No output)' : data.stdout); // Handle empty stdout
             } else {
                 setOutputType("warning");
                 setOutput("No output generated or unknown execution state.");
             }
        } catch (error) {
             console.error("Error running code:", error);
             setOutputType("error");
             setOutput(error.response?.data?.message || "Error connecting to execution server. Please try again.");
        } finally {
             setIsRunning(false);
        }
    };
    // --- End Run Code Logic ---

    // --- Output Panel Styling Helpers ---
    const getOutputHeaderColor = () => {
         switch (outputType) {
             case "success": return "bg-gray-700";
             case "error": return "bg-gray-700 border-l-4 border-red-500";
             case "warning": return "bg-gray-700 border-l-4 border-yellow-500";
             default: return "bg-gray-700";
         }
     };

    const getOutputTitleColor = () => {
         switch (outputType) {
             case "success": return "text-green-400";
             case "error": return "text-red-400";
             case "warning": return "text-yellow-400";
             default: return "text-gray-400";
         }
     };

    const getOutputTitle = () => {
         switch (outputType) {
             case "success": return "Output";
             case "error": return "Error";
             case "warning": return "Warning";
             default: return "Console";
         }
     };
    // --- End Output Panel Styling Helpers ---

    // Determine if the run button should be disabled
    // Disable if: code is running, or not connected to WebSocket
    const isRunButtonDisabled = isRunning || !isConnected;

    return (
        <div className="h-screen flex flex-col bg-gray-900 text-gray-100">
            {/* Header */}
            <div className="flex justify-between items-center p-4 bg-gray-800 border-b border-gray-700">
                <div className="flex items-center">
                    <h1 className="text-xl font-semibold mr-4">Unicode</h1>
                    <div className="bg-gray-700 px-3 py-1 rounded text-sm" title={`Project ID: ${projectId}`}>
                        Project: {projectId ? projectId.substring(0, 8) + '...' : 'Loading...'}
                    </div>
                    {/* Connection Status Indicator */}
                    <span className={`ml-3 h-3 w-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}
                          title={isConnected ? 'Connected to collaboration server' : 'Disconnected from collaboration server'}>
                    </span>
                </div>

                <div className="flex items-center space-x-2">
                    <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="p-2 bg-gray-700 text-gray-200 rounded border-none outline-none focus:ring-1 focus:ring-blue-500"
                        style={{ WebkitAppearance: "menulist" }} // For better dropdown appearance on Webkit
                    >
                        <option value="javascript">JavaScript</option>
                        <option value="python">Python</option>
                        <option value="c">C</option>
                        <option value="cpp">C++</option>
                    </select>

                    <button
                        onClick={runCode}
                        disabled={isRunButtonDisabled}
                        className={`px-4 py-2 rounded-md flex items-center space-x-2 transition-colors ${isRunButtonDisabled ? 'bg-gray-600 cursor-not-allowed opacity-70' : 'bg-blue-600 hover:bg-blue-500'}`}
                        title={!isConnected ? "Connecting to collaboration server..." : isRunning ? "Code is running..." : "Run Code"}
                    >
                        {isRunning ? (
                            <> {/* Running Indicator */}
                                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                <span>Running...</span>
                            </>
                        ) : (
                            <> {/* Run Icon */}
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                                </svg>
                                <span>Run Code</span>
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Editor Section */}
            <div className="flex-1 overflow-hidden">
                <MonacoEditor
                    height="100%" // Ensure editor fills the container
                    language={language}
                    theme="vs-dark"
                    onMount={handleEditorDidMount} // Setup Yjs binding here
                    options={{
                        minimap: { enabled: true },
                        scrollBeyondLastLine: false,
                        fontSize: 14,
                        fontFamily: "'Fira Code', monospace", // Ensure font is available or use a common fallback
                        fontLigatures: true, // Enable font ligatures if Fira Code supports them
                        automaticLayout: true, // Adjusts editor layout on container resize
                        wordWrap: "on", // Optional: wrap long lines
                        padding: { top: 10 } // Optional: add some padding
                    }}
                    // value={/* Do not set value directly when using Yjs binding */}
                />
            </div>

            {/* Resize handle */}
            <div
                id="resize-handle"
                className="h-1.5 bg-gray-700 hover:bg-blue-500 cursor-ns-resize transition-colors duration-150 ease-in-out"
                title="Drag to resize"
            ></div>

            {/* Output Section */}
            <div ref={outputResizeRef} className="flex flex-col bg-gray-800" style={{ height: "200px", minHeight: "50px", overflow: "hidden" }}>
                <div className={`flex justify-between items-center px-4 py-1 border-b border-gray-700 ${getOutputHeaderColor()}`}>
                    <div className="font-medium flex items-center">
                        <span className={getOutputTitleColor()}>{getOutputTitle()}</span>
                    </div>
                    <div className="text-xs text-gray-400">
                        {/* Status message */}
                    </div>
                </div>

                <div className="p-4 flex-1 overflow-auto font-mono text-sm bg-gray-800 text-gray-200">
                    {output !== null && output !== undefined ? ( // Check if output exists
                        <pre className="whitespace-pre-wrap break-words">{output}</pre>
                    ) : (
                        <div className="flex h-full items-center justify-center text-gray-500 italic">
                            <span>Output will appear here...</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}