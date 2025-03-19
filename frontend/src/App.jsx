import { Routes, Route } from "react-router-dom";
import EditorPage from "./pages/EditorPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import AuthPage from "./pages/AuthPage.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AuthPage />} />
      <Route path="/join" element={<LoginPage />} />
      <Route path="/editor/:projectId" element={<EditorPage />} />
    </Routes>
  );
}
