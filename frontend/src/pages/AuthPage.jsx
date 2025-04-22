import { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";

export default function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleAuth = async () => {
    setError("");
    const endpoint = isLogin ? "login" : "register";

    try {
      const { data } = await axios.post(`https://unicode-production.up.railway.app/api/auth/${endpoint}`, {
        username,
        password,
      });

      if (isLogin) {
        localStorage.setItem("token", data.token);
        navigate("/join");
      } else {
        alert("Signup successful! You can now log in.");
        setIsLogin(true);
      }
    } catch (err) {
      setError(err.response?.data?.msg || "Authentication failed");
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
      <h1 className="text-3xl mb-4">{isLogin ? "Login" : "Signup"}</h1>
      {error && <p className="text-red-500">{error}</p>}
      <input
        className="p-2 m-2 border rounded text-white"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="password"
        className="p-2 m-2 border rounded text-white"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="px-4 py-2 bg-blue-600 rounded" onClick={handleAuth}>
        {isLogin ? "Login" : "Signup"}
      </button>
      <button className="mt-2 text-sm text-gray-400" onClick={() => setIsLogin(!isLogin)}>
        {isLogin ? "Create an account" : "Already have an account? Login"}
      </button>
    </div>
  );
}
