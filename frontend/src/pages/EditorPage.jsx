import { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import MonacoEditor from "@monaco-editor/react";
import axios from "axios";

const socket = io("https://unicode-37d2.onrender.com");

export default function EditorPage() {
  const { projectId } = useParams();
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("javascript");
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [outputType, setOutputType] = useState("success"); // success, error, warning
  const outputResizeRef = useRef(null);

  useEffect(() => {
    socket.emit("joinProject", { projectId });

    axios.get(`https://unicode-37d2.onrender.com/api/projects/${projectId}`)
      .then((res) => setCode(res.data.code))
      .catch(() => setCode("// Start coding here"));

    socket.on("codeChange", ({ code }) => setCode(code));

    // Setup resizable output panel
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
      // Set minimum and maximum heights
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

    return () => {
      socket.disconnect();
      if (resizeHandle) {
        resizeHandle.removeEventListener('mousedown', startResize);
      }
      document.documentElement.removeEventListener('mousemove', resize);
      document.documentElement.removeEventListener('mouseup', stopResize);
    };
  }, [projectId]);

  const handleCodeChange = (newCode) => {
    setCode(newCode);
    socket.emit("codeChange", { projectId, code: newCode });

    axios.post("https://unicode-37d2.onrender.com/api/projects/update", { projectId, code: newCode })
      .catch((err) => console.log(err));
  };

  const runCode = async () => {
    setIsRunning(true);
    setOutput("Running code...");
    
    try {
      const { data } = await axios.post("https://unicode-37d2.onrender.com/api/run", { code, language });

      if (data.stdout) {
        setOutputType("success");
        setOutput(`${data.stdout}`);
      } else if (data.compile_output) {
        setOutputType("error");
        setOutput(`${data.compile_output}`);
      } else if (data.stderr) {
        setOutputType("error");
        setOutput(`${data.stderr}`);
      } else {
        setOutputType("warning");
        setOutput("No output generated or unknown error occurred");
      }
    } catch (error) {
      setOutputType("error");
      setOutput("Error connecting to server. Please try again.");
    } finally {
      setIsRunning(false);
    }
  };

  

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

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="flex justify-between items-center p-4 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center">
          <h1 className="text-xl font-semibold mr-4">Unicode</h1>
          <div className="bg-gray-700 px-3 py-1 rounded text-sm">Project: {projectId}</div>
        </div>
        
        <div className="flex items-center space-x-2">
          {/* Improved language selector */}
          <div className="flex items-center">
            
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="p-2 bg-gray-700 text-gray-200 rounded-r border-none outline-none focus:ring-1 focus:ring-blue-500"
              style={{ WebkitAppearance: "menulist" }} // Ensures dropdown arrow is visible
            >
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="c">C</option>
              <option value="cpp">C++</option>
            </select>
          </div>
          
          <button 
            onClick={runCode}
            disabled={isRunning} 
            className={`px-4 py-2 rounded-md flex items-center space-x-2 transition-colors 
              ${isRunning 
                ? 'bg-blue-700 cursor-not-allowed' 
                : 'bg-blue-600 hover:bg-blue-500'}`}
          >
            {isRunning ? (
              <>
                <span className="animate-pulse">⏳</span>
                <span>Running...</span>
              </>
            ) : (
              <>
                
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
          onChange={handleCodeChange}
          options={{
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            fontSize: 14,
            fontFamily: "'Fira Code', monospace",
          }}
        />
      </div>

      {/* Resize handle */}
      <div 
        id="resize-handle" 
        className="h-1 bg-gray-700 hover:bg-blue-500 cursor-ns-resize" 
        title="Drag to resize"
      ></div>

      {/* Output Section - Now matching UI colors and resizable */}
      <div ref={outputResizeRef} className="border-t border-gray-700 bg-gray-800" style={{ height: "200px", minHeight: "100px" }}>
        <div className={`flex justify-between items-center px-4 py-2 ${getOutputHeaderColor()}`}>
          <div className="font-medium flex items-center">
            
            <span className={getOutputTitleColor()}>{getOutputTitle()}</span>
          </div>
          <div className="text-xs text-gray-400">
            {outputType === "success" && output && "Execution completed successfully"}
            {outputType === "error" && "Execution failed with errors"}
            {outputType === "warning" && "Execution completed with warnings"}
          </div>
        </div>
        
        <div className="p-4 h-full overflow-auto font-mono text-sm bg-gray-800 text-gray-200">
          {output ? (
            <pre className="whitespace-pre-wrap">{output}</pre>
          ) : (
            <div className="flex h-full items-center justify-center text-gray-500">
              <span>Code output will appear here after running</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}