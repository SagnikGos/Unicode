import React, { useState } from "react"; // Removed unused imports for brevity
import { useNavigate } from "react-router-dom";
import axios from "axios";

// Consider renaming this component if it's more for joining/creating projects
// than general login, e.g., ProjectAccessPage
export default function LoginPage() {
    const [projectId, setProjectId] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState(""); // Added state for error messages
    const [isLoading, setIsLoading] = useState(false); // Added loading state
    const navigate = useNavigate();

    const joinProject = async () => {
        setError(""); // Clear previous errors
        setIsLoading(true); // Set loading state

        // --- ** START: Added Token Handling ** ---
        // 1. Retrieve the token from storage
        // !!! Replace 'authToken' with the actual key you use !!!
        const token = localStorage.getItem('token');

        if (!token) {
            setError("Authentication error: You must be logged in to join or create a project.");
            setIsLoading(false);
            return; // Stop if not logged in
        }

        // 2. Create Axios request config with Authorization header
        const config = {
            headers: {
                'Content-Type': 'application/json',
                // Include the Bearer token
                'Authorization': `Bearer ${token}`
            }
        };
        // --- ** END: Added Token Handling ** ---

        try {
            const body = { projectId, password };
            // 3. Send request with data AND config (including headers)
            await axios.post("https://unicode-production.up.railway.app/api/projects/join", body, config);

            // If successful, navigate to the editor
            navigate(`/editor/${projectId}`);

        } catch (err) {
            console.error("Error joining/creating project:", err);
            // Improve error message based on response
            let message = "An unexpected error occurred.";
            if (err.response) {
                // Use error message from backend if available
                message = err.response.data?.errors?.[0]?.msg || err.response.data?.msg || `Server error: ${err.response.status}`;
            } else if (err.request) {
                message = "No response from server. Please check your connection.";
            } else {
                message = err.message;
            }
            setError(message); // Set specific error message
            // Removed alert("Invalid Project ID or Password"); use state instead
        } finally {
             setIsLoading(false); // Reset loading state
        }
    };

    return (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
            <h1 className="text-3xl mb-4">Join or Create Project</h1> {/* Updated Title */}
            {/* Display Error Message */}
            {error && <p className="text-red-500 mb-4">{error}</p>}
            <input
                className="p-2 m-2 border rounded bg-gray-800 border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" // Improved styling
                placeholder="Project ID"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={isLoading} // Disable input while loading
            />
            <input
                type="password"
                className="p-2 m-2 border rounded bg-gray-800 border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" // Improved styling
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading} // Disable input while loading
            />
            <button
                className={`px-4 py-2 rounded transition-colors ${isLoading ? 'bg-gray-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'}`}
                onClick={joinProject}
                disabled={isLoading} // Disable button while loading
            >
                {isLoading ? 'Processing...' : 'Join / Create'} {/* Updated Button Text */}
            </button>
        </div>
    );
}