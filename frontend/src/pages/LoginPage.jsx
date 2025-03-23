import { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";

export default function LoginPage() {
  const [projectId, setProjectId] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  const joinProject = async () => {
    try {
      await axios.post("https://unicode-37d2.onrender.com/api/projects/join", { projectId, password });
      navigate(`/editor/${projectId}`);
    } catch (err) {
      alert("Invalid Project ID or Password");
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
      <h1 className="text-3xl mb-4">Join a Project</h1>
      <input
        className="p-2 m-2 border rounded text-white"
        placeholder="Project ID"
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
      />
      <input
        type="password"
        className="p-2 m-2 border rounded text-white"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="px-4 py-2 bg-blue-600 rounded" onClick={joinProject}>Join</button>
    </div>
  );
}
