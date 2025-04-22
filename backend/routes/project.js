// --- File: routes/project.js ---

const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose'); // Import mongoose for ObjectId check
const { body, validationResult } = require('express-validator');
const Project = require('../models/project'); // Adjust path if needed
const authMiddleware = require('../middleware/auth'); // Adjust path if needed

const router = express.Router();

// @route   POST /api/projects/join
// @desc    Join an existing project by ID or Name, or create a new one by Name
// @access  Private (Requires valid JWT via authMiddleware)
router.post(
    '/join',
    [
        authMiddleware, // Ensures req.user.id is available
        // Validate the user input - could be name or ID
        body('projectId', 'Project name or ID is required').not().isEmpty(),
        // Assuming password is required for both joining existing and creating new
        body('password', 'Password is required').not().isEmpty()
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        // Rename for clarity: this is what the user typed (could be name or ID)
        const { projectId: userInput, password } = req.body;
        const userId = req.user.id; // Get user ID from authenticated request

        try {
            let project;
            let needsSave = false; // Flag to save project if members array is modified
            let isNew = false;     // Flag to indicate if a new project was created

            // --- CORRECTED LOGIC: Find by ID or Name / Create by Name ---

            // 1. Check if userInput is potentially a valid MongoDB ObjectId
            if (mongoose.Types.ObjectId.isValid(userInput)) {
                // Use findById for efficiency when querying by ObjectId
                project = await Project.findById(userInput);
                if (project) {
                    console.log(`[Project Join/Create] Found existing project by ID: ${userInput}`);
                    // Project found by ID, verify password
                    // ** ASSUMPTION: Your Project schema has a 'password' field **
                    const isMatch = await bcrypt.compare(password, project.password);
                    if (!isMatch) {
                        return res.status(400).json({ errors: [{ msg: 'Invalid project credentials' }] });
                    }
                    // Add user to members if not already present
                    // ** ASSUMPTION: Your Project schema has 'members': [ObjectId] field **
                    if (!project.members?.includes(userId)) {
                        console.log(`[Project Join/Create] Adding user ${userId} to project ${project._id} found by ID.`);
                        project.members.push(userId);
                        needsSave = true;
                    }
                }
                // If findById returns null (valid ObjectId format but no project), proceed to check by name
            }

            // 2. If not found by ID (or if userInput wasn't a valid ID format), treat userInput as a project NAME
            if (!project) {
                // ** ASSUMPTION: Your Project schema has a 'name' field (String) for user-defined names **
                project = await Project.findOne({ name: userInput }); // Query by name
                if (project) {
                    console.log(`[Project Join/Create] Found existing project by Name: ${userInput}`);
                     // Project found by name, verify password
                     const isMatch = await bcrypt.compare(password, project.password);
                     if (!isMatch) {
                         return res.status(400).json({ errors: [{ msg: 'Invalid project credentials' }] });
                     }
                     // Add user to members if not already present
                     if (!project.members?.includes(userId)) {
                        console.log(`[Project Join/Create] Adding user ${userId} to project ${project._id} found by name.`);
                        project.members.push(userId);
                        needsSave = true;
                     }
                } else {
                    // 3. Project not found by ID or Name - Create a new project using userInput as the NAME
                    console.log(`[Project Join/Create] Creating new project with name: ${userInput}`);
                    isNew = true;
                    const salt = await bcrypt.genSalt(10);
                    const hashedPassword = await bcrypt.hash(password, salt);

                    project = new Project({
                        name: userInput, // Save the user input as the project name
                        password: hashedPassword, // Save hashed password
                        // ** ASSUMPTION: Your Project schema has 'owner': ObjectId field **
                        owner: userId, // Set the creator as the owner
                        members: [userId], // Add the creator to the members list
                        // code: '// Start coding here!' // Optional: Only if NOT using Yjs persistence for initial state
                    });
                    needsSave = true; // Need to save the new project object
                }
            }

            // --- END CORRECTED LOGIC ---

            // Save project if it's new or members array was modified
            if (needsSave) {
                await project.save();
                 console.log(`[Project Join/Create] Project ${isNew ? 'created' : 'updated/joined'}. DB ID: ${project._id}`);
            }

            // --- CRITICAL FIX: Respond with the actual MongoDB _id ---
            res.status(isNew ? 201 : 200).json({ // Use 201 for created, 200 for joined/found
                message: `Project ${isNew ? 'created' : 'joined'} successfully.`,
                // Use a consistent key (like 'projectId'), BUT send the DATABASE ID (_id) as a string
                projectId: project._id.toString()
            });
            // --- END CRITICAL FIX ---

        } catch (err) {
            console.error("Error in /join route:", err.message, err.stack); // Log stack trace
            res.status(500).send('Server error');
        }
    }
);

// --- GET Project Route (Example - Keep or Modify as Needed) ---

// @route   GET /api/projects/:projectId
// @desc    Get project details (ensure authorization)
// @access  Private
router.get(
    '/:projectId', // This param should ideally be the MongoDB ObjectId
    authMiddleware,
    async (req, res) => {
        const requestedProjectId = req.params.projectId;
        const userId = req.user.id; // From auth middleware

        // Validate the incoming projectId format for safety
        if (!mongoose.Types.ObjectId.isValid(requestedProjectId)) {
            console.warn(`[Project GET] Invalid ObjectId format requested: ${requestedProjectId}`);
            return res.status(400).json({ msg: 'Invalid project ID format' });
        }

        try {
            // Find project by its actual MongoDB _id
            const project = await Project.findById(requestedProjectId);

            if (!project) {
                return res.status(404).json({ msg: 'Project not found' });
            }

            // Authorization Check: Ensure the requesting user is in the project's members array
            // ** ASSUMPTION: Schema has 'members': [ObjectId] **
            if (!project.members?.includes(userId)) {
                 console.warn(`User ${userId} forbidden from accessing project ${requestedProjectId} via GET request.`);
                 return res.status(403).json({ msg: 'Forbidden: You do not have access to this project' });
            }

            // If authorized, return relevant info
            // Avoid sending sensitive info like the password hash
            res.json({
                 projectId: project._id.toString(), // Send the actual ID
                 name: project.name,              // Send the name
                 owner: project.owner,            // Send owner ID
                 memberCount: project.members?.length || 0, // Example metadata
                 // code: project.code // Usually not needed if Yjs is primary source of truth
             });

        } catch (err) {
            console.error(`Error fetching project ${requestedProjectId}:`, err.message, err.stack);
            res.status(500).send('Server error');
        }
    }
);

// --- Add other project-related routes here if needed (e.g., list projects for user) ---
// Example: GET /api/projects (list projects user is a member of)
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        // Find projects where the user's ID is in the 'members' array
        const projects = await Project.find({ members: userId }).select('name owner _id createdAt'); // Select only needed fields
        res.json(projects);
    } catch (err) {
        console.error("Error fetching user's projects:", err.message, err.stack);
        res.status(500).send('Server error');
    }
});


module.exports = router;