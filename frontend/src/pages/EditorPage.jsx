import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import MonacoEditor from "@monaco-editor/react";
import axios from "axios";

const socket = io("http://localhost:3001");

export default function EditorPage() {
  const { projectId } = useParams();
  const [code, setCode] = useState("");

  useEffect(() => {
    socket.emit("joinProject", { projectId });

    axios.get(`http://localhost:3001/api/projects/${projectId}`)
      .then((res) => setCode(res.data.code))
      .catch(() => setCode("// Start coding here"));

    socket.on("codeChange", ({ code }) => setCode(code));

    return () => {
      socket.disconnect();
    };
  }, [projectId]);

  const handleCodeChange = (newCode) => {
    setCode(newCode);
    socket.emit("codeChange", { projectId, code: newCode });

    axios.post("http://localhost:3001/api/projects/update", { projectId, code: newCode })
      .catch((err) => console.log(err));
  };

  return (
    <div className="h-screen">
      <MonacoEditor
        height="100vh"
        defaultLanguage="javascript"
        theme="vs-dark"
        value={code}
        onChange={handleCodeChange}
      />
    </div>
  );
}
