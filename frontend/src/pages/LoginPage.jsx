// --- Inside ProjectAccessPage.js (or LoginPage.js) ---

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";

export default function ProjectAccessPage() { // Or LoginPage
    const [projectIdInput, setProjectIdInput] = useState(""); // What user types
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
            // Send the user's input (name or ID) to the backend
            const body = { projectId: projectIdInput, password };

            console.log(`[Client] Attempting to join/create project with input: ${projectIdInput}`); // Log input

            // --- Step 1: Make API Call and Await Response ---
            const { data } = await axios.post(
                "https://unicode-production.up.railway.app/api/projects/join", // Your API endpoint
                body,
                config
            );

            console.log("[Client] Received response from /api/projects/join:", data); // Log the *entire* response data

            // --- Step 2: Extract the *ACTUAL* Project ID from the Backend Response ---
            // *** CRITICAL: Your backend MUST return the correct MongoDB ObjectId ***
            // Adjust 'data.projectId' if your backend uses a different field name (e.g., data.project._id)
            const actualProjectId = data.projectId;

            // --- Step 3: Validate the Received ID ---
            if (!actualProjectId || typeof actualProjectId !== 'string') {
                 // Basic check if the expected ID is missing or not a string
                 console.error("[Client] Error: Backend response did not contain a valid 'projectId' string.", data);
                 setError("Failed to get project information from the server. API might need adjustment.");
                 setIsLoading(false);
                 return;
            }

            // Optional: You could even add a quick client-side format check here, though the backend already does it.
            // const objectIdRegex = /^[0-9a-fA-F]{24}$/;
            // if (!objectIdRegex.test(actualProjectId)) {
            //    console.error("[Client] Error: Project ID received from backend is not a valid ObjectId format:", actualProjectId);
            //    setError("Received invalid project data from the server.");
            //    setIsLoading(false);
            //    return;
            // }


            console.log(`[Client] Navigation target ID (from backend): ${actualProjectId}`); // Log the ID used for navigation

            // --- Step 4: Navigate Using the ID from the Backend Response ---
            navigate(`/editor/${actualProjectId}`); // Use the ID confirmed by the backend

        } catch (err) {
            console.error("Error joining/creating project:", err);
            let message = "An unexpected error occurred.";
            if (err.response) {
                // Try to get the most specific error message from the backend response
                message = err.response.data?.errors?.[0]?.msg || err.response.data?.msg || `Server error: ${err.response.status}`;
                console.error("Backend error response:", err.response.data); // Log backend error details
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

    // --- The rest of the component's return statement (JSX) remains the same ---
    // (Input fields for projectIdInput, password, button calling joinProject, etc.)
    return (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
            {/* ... JSX structure as previously provided ... */}
             <h1 className="text-3xl mb-4">Join or Create Project</h1>
             {error && <p className="text-red-500 mb-4 text-center px-4">{error}</p>}
             <input
                 className="p-2 m-2 border rounded w-80 bg-gray-800 border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="Project Name or ID to Join"
                 value={projectIdInput}
                 onChange={(e) => setProjectIdInput(e.target.value)}
                 disabled={isLoading}
             />
             <input
                 type="password"
                 className="p-2 m-2 border rounded w-80 bg-gray-800 border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="Project Password (if required)"
                 value={password}
                 onChange={(e) => setPassword(e.target.value)}
                 disabled={isLoading}
             />
             <button
                 className={`px-4 py-2 mt-2 rounded transition-colors w-80 ${isLoading ? 'bg-gray-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'}`}
                 onClick={joinProject}
                 disabled={isLoading || !projectIdInput}
             >
                 {isLoading ? 'Processing...' : 'Join / Create'}
             </button>
        </div>
    );
}