import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";

// Renamed for clarity, reflects its function better
export default function ProjectAccessPage() {
    const [projectIdInput, setProjectIdInput] = useState(""); // What the user types
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const navigate = useNavigate();

    const joinProject = async () => {
        setError("");
        setIsLoading(true);

        const token = localStorage.getItem('token'); // Ensure 'token' is your correct key

        if (!token) {
            setError("Authentication error: Please log in first.");
            setIsLoading(false);
            return;
        }

        const config = {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        };

        try {
            // Send the projectId typed by the user (it might be a name for creation, or an ID for joining)
            const body = { projectId: projectIdInput, password };

            // --- FIX: Capture the response data ---
            const { data } = await axios.post(
                "https://unicode-production.up.railway.app/api/projects/join", // Or potentially a create/join endpoint
                body,
                config
            );

            // --- FIX: Extract the *actual* projectId returned by the backend ---
            // *** CRITICAL: Adjust 'data.projectId' based on your actual API response structure ***
            // Your backend MUST return the definitive ObjectId here.
            const actualProjectId = data.projectId;

            if (!actualProjectId) {
                 // Handle case where backend didn't return the expected ID
                 console.error("Backend response missing required projectId field:", data);
                 setError("Failed to get valid project ID from server response. Please check API.");
                 setIsLoading(false);
                 return;
            }

            // --- FIX: Navigate using the ID from the backend response ---
            navigate(`/editor/${actualProjectId}`);

        } catch (err) {
            console.error("Error joining/creating project:", err);
            let message = "An unexpected error occurred.";
            if (err.response) {
                message = err.response.data?.errors?.[0]?.msg || err.response.data?.msg || `Server error: ${err.response.status}`;
            } else if (err.request) {
                message = "No response from server. Check connection or backend status.";
            } else {
                message = err.message;
            }
            setError(message);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
            <h1 className="text-3xl mb-4">Join or Create Project</h1>
            {error && <p className="text-red-500 mb-4 text-center px-4">{error}</p>}
            <input
                className="p-2 m-2 border rounded w-80 bg-gray-800 border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" // Improved styling
                placeholder="Project Name or ID to Join" // Clarified placeholder
                value={projectIdInput} // Use dedicated state for input
                onChange={(e) => setProjectIdInput(e.target.value)}
                disabled={isLoading}
            />
            <input
                type="password"
                className="p-2 m-2 border rounded w-80 bg-gray-800 border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" // Improved styling
                placeholder="Project Password (if required)" // Clarified placeholder
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
            />
            <button
                className={`px-4 py-2 mt-2 rounded transition-colors w-80 ${isLoading ? 'bg-gray-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'}`}
                onClick={joinProject}
                disabled={isLoading || !projectIdInput} // Also disable if input is empty
            >
                {isLoading ? 'Processing...' : 'Join / Create'}
            </button>
            {/* Optional: Add a button to navigate back or to a dashboard */}
            {/* <button onClick={() => navigate('/dashboard')} className="mt-4 text-sm text-gray-400 hover:text-gray-200">Back to Dashboard</button> */}
        </div>
    );
}