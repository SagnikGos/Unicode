import { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import MonacoEditor from "@monaco-editor/react";
import axios from "axios";

// Initialize socket connection
const socket = io("https://unicode-37d2.onrender.com");

export default function EditorPage() {
    const { projectId } = useParams();
    const [code, setCode] = useState("");
    const [language, setLanguage] = useState("javascript");
    const [output, setOutput] = useState("");
    const [isRunning, setIsRunning] = useState(false);
    const [outputType, setOutputType] = useState("success"); // success, error, warning
    const outputResizeRef = useRef(null);
    // Ref to store the debounce timeout ID
    const debounceTimeoutRef = useRef(null);

    useEffect(() => {
        // Join project room on mount
        socket.emit("joinProject", { projectId });

        // Fetch initial code
        axios.get(`https://unicode-37d2.onrender.com/api/projects/${projectId}`)
            .then((res) => {
                // Only set initial code if it hasn't been set already (prevents overriding local changes)
                if (code === "") {
                    setCode(res.data.code || "// Start coding here");
                }
            })
            .catch(() => {
                if (code === "") {
                    setCode("// Start coding here");
                }
            });

        // Listen for incoming code changes from others
        const handleIncomingCodeChange = ({ code: incomingCode }) => {
            // Optional: You might want to add logic here to prevent overwriting
            // the user's code if they are actively typing, or use more
            // sophisticated merging if using Operational Transformation (OT) or CRDTs.
            // For now, it directly sets the code.
            setCode(incomingCode);
        };
        socket.on("codeChange", handleIncomingCodeChange);

        // --- Resizable Output Panel Logic ---
        const resizeableOutput = outputResizeRef.current;
        let startY, startHeight;

        function startResize(e) {
            startY = e.clientY;
            startHeight = parseInt(document.defaultView.getComputedStyle(resizeableOutput).height, 10);
            document.documentElement.addEventListener('mousemove', resize);
            document.documentElement.addEventListener('mouseup', stopResize);
            e.preventDefault();
        }

        function resize(e) {
            const newHeight = startHeight - (e.clientY - startY);
            if (newHeight > 50 && newHeight < window.innerHeight / 2) {
                resizeableOutput.style.height = `${newHeight}px`;
            }
        }

        function stopResize() {
            document.documentElement.removeEventListener('mousemove', resize);
            document.documentElement.removeEventListener('mouseup', stopResize);
        }

        const resizeHandle = document.getElementById('resize-handle');
        if (resizeHandle) {
            resizeHandle.addEventListener('mousedown', startResize);
        }
        // --- End Resizable Output Panel Logic ---

        // Cleanup on component unmount
        return () => {
            socket.off("codeChange", handleIncomingCodeChange); // Remove specific listener
            socket.disconnect();
            if (resizeHandle) {
                resizeHandle.removeEventListener('mousedown', startResize);
            }
            // Clean up potential lingering listeners from resize logic
            document.documentElement.removeEventListener('mousemove', resize);
            document.documentElement.removeEventListener('mouseup', stopResize);
            // Clear the debounce timeout if the component unmounts
            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }
        };
        // Only re-run effect if projectId changes
    }, [projectId]); // Removed 'code' from dependency array to prevent issues with socket listeners

    // --- Debounced Code Change Handler ---
    const handleCodeChange = (newCode) => {
        // Update local state immediately for smooth UI
        setCode(newCode);

        // Clear any existing debounce timeout
        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }

        // Set a new timeout to send updates after 500ms of inactivity
        debounceTimeoutRef.current = setTimeout(() => {
            // Emit code change via WebSocket
            socket.emit("codeChange", { projectId, code: newCode });

            // **RECOMMENDATION**: Consider removing this HTTP POST from here.
            // Saving on every debounced change might still be too frequent.
            // Explore saving periodically, on blur, via a save button,
            // or letting the backend handle saves based on WebSocket messages.
            axios.post("https://unicode-37d2.onrender.com/api/projects/update", { projectId, code: newCode })
                .then(() => console.log("Code saved automatically.")) // Optional: feedback
                .catch((err) => console.error("Error auto-saving code:", err));

        }, 500); // Debounce time: 500 milliseconds
    };
    // --- End Debounced Code Change Handler ---

    // --- Run Code Logic ---
    const runCode = async () => {
        setIsRunning(true);
        setOutput("Running code...");
        setOutputType("success"); // Reset output type

        try {
            const { data } = await axios.post("https://unicode-37d2.onrender.com/api/run", { code, language });

            if (data.stderr || data.compile_output) {
                setOutputType("error");
                setOutput(data.stderr || data.compile_output);
            } else if (data.stdout) {
                setOutputType("success");
                setOutput(data.stdout);
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

    // --- Output Panel Styling ---
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
    // --- End Output Panel Styling ---

    return (
        <div className="h-screen flex flex-col bg-gray-900 text-gray-100">
            {/* Header */}
            <div className="flex justify-between items-center p-4 bg-gray-800 border-b border-gray-700">
                <div className="flex items-center">
                    <h1 className="text-xl font-semibold mr-4">Unicode</h1>
                    <div className="bg-gray-700 px-3 py-1 rounded text-sm">Project: {projectId}</div>
                </div>

                <div className="flex items-center space-x-2">
                    <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="p-2 bg-gray-700 text-gray-200 rounded border-none outline-none focus:ring-1 focus:ring-blue-500"
                        style={{ WebkitAppearance: "menulist" }}
                    >
                        <option value="javascript">JavaScript</option>
                        <option value="python">Python</option>
                        <option value="c">C</option>
                        <option value="cpp">C++</option>
                        {/* Add other languages as needed */}
                    </select>

                    <button
                        onClick={runCode}
                        disabled={isRunning}
                        className={`px-4 py-2 rounded-md flex items-center space-x-2 transition-colors
                          ${isRunning
                                ? 'bg-blue-700 cursor-not-allowed opacity-70'
                                : 'bg-blue-600 hover:bg-blue-500'}`}
                    >
                        {isRunning ? (
                            <>
                                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                <span>Running...</span>
                            </>
                        ) : (
                            <>
                                {/* Play Icon (example) */}
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
                    height="100%"
                    language={language}
                    theme="vs-dark"
                    value={code}
                    onChange={handleCodeChange} // Use the debounced handler
                    options={{
                        minimap: { enabled: true },
                        scrollBeyondLastLine: false,
                        fontSize: 14,
                        fontFamily: "'Fira Code', monospace", // Ensure Fira Code is loaded or use alternatives
                        automaticLayout: true, // Helps editor resize correctly
                    }}
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
                        {/* Simplified status messages */}
                        {outputType === "success" && output && "Completed"}
                        {outputType === "error" && "Failed"}
                        {outputType === "warning" && "Completed with warnings"}
                    </div>
                </div>

                <div className="p-4 flex-1 overflow-auto font-mono text-sm bg-gray-800 text-gray-200">
                    {output ? (
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