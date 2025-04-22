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
        body('projectId', 'Project name or ID is required').not().isEmpty(),
        body('password', 'Password is required').not().isEmpty()
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { projectId: userInput, password } = req.body; // User input (e.g., "kikikuku")
        const userId = req.user.id;

        try {
            let project;
            let needsSave = false;
            let isNew = false;

            // 1. Check if userInput is potentially a valid MongoDB ObjectId
            if (mongoose.Types.ObjectId.isValid(userInput)) {
                project = await Project.findById(userInput);
                if (project) {
                    console.log(`[Project Join/Create] Found existing project by ID: ${userInput}`);
                    // Project found by ID, verify password
                    const isMatch = await bcrypt.compare(password, project.password); // Assumes 'password' field
                    if (!isMatch) {
                        return res.status(400).json({ errors: [{ msg: 'Invalid project credentials' }] });
                    }
                    // Add user to members if not already present
                    if (!project.members?.includes(userId)) { // Assumes 'members' field
                        console.log(`[Project Join/Create] Adding user ${userId} to project ${project._id} found by ID.`);
                        project.members.push(userId);
                        needsSave = true;
                    }
                }
            }

            // 2. If not found by ID, treat userInput as a project NAME
            if (!project) {
                project = await Project.findOne({ name: userInput }); // Assumes 'name' field
                if (project) {
                    console.log(`[Project Join/Create] Found existing project by Name: ${userInput}`);
                     const isMatch = await bcrypt.compare(password, project.password);
                     if (!isMatch) {
                         return res.status(400).json({ errors: [{ msg: 'Invalid project credentials' }] });
                     }
                     if (!project.members?.includes(userId)) {
                        console.log(`[Project Join/Create] Adding user ${userId} to project ${project._id} found by name.`);
                        project.members.push(userId);
                        needsSave = true;
                     }
                } else {
                    // 3. Project not found by ID or Name - Create a new project
                    console.log(`[Project Join/Create] Creating new project with name/id: ${userInput}`); // Log clarifies input used
                    isNew = true;
                    const salt = await bcrypt.genSalt(10);
                    const hashedPassword = await bcrypt.hash(password, salt);

                    // --- FIX: Provide the 'projectId' field required by schema ---
                    project = new Project({
                        name: userInput, // Assumes you want to store the input as 'name'
                        projectId: userInput, // ** ADDED THIS to satisfy the schema validation **
                        password: hashedPassword, // Assumes 'password' field
                        owner: userId, // Assumes 'owner' field
                        members: [userId], // Assumes 'members' field
                        // code: '// Start coding here!' // Optional default code
                    });
                    // --- END FIX ---
                    needsSave = true;
                }
            }

            // Save project if it's new or members array was modified
            if (needsSave) {
                await project.save(); // Should succeed now as required fields are provided
                 console.log(`[Project Join/Create] Project ${isNew ? 'created' : 'updated/joined'}. DB ID: ${project._id}, UserInputName/ID: ${userInput}`);
            }

            // --- CRITICAL: Respond with the actual MongoDB _id ---
            // This part remains correct and unchanged from the previous fix.
            res.status(isNew ? 201 : 200).json({
                message: `Project ${isNew ? 'created' : 'joined'} successfully.`,
                // Always send the DATABASE ID (_id) as 'projectId' in the response
                projectId: project._id.toString()
            });
            // --- END CRITICAL ---

        } catch (err) {
            console.error("Error in /join route:", err.message, err.stack);
            res.status(500).send('Server error');
        }
    }
);

// --- GET Project Route (Example - Keep or Modify as Needed) ---
router.get(
    '/:projectId', // This param should be the MongoDB ObjectId
    authMiddleware,
    async (req, res) => {
        const requestedProjectId = req.params.projectId;
        const userId = req.user.id;

        if (!mongoose.Types.ObjectId.isValid(requestedProjectId)) {
            console.warn(`[Project GET] Invalid ObjectId format requested: ${requestedProjectId}`);
            return res.status(400).json({ msg: 'Invalid project ID format' });
        }

        try {
            const project = await Project.findById(requestedProjectId); // Find by actual _id
            if (!project) {
                return res.status(404).json({ msg: 'Project not found' });
            }
            if (!project.members?.includes(userId)) { // Assumes 'members' field
                 console.warn(`User ${userId} forbidden from accessing project ${requestedProjectId} via GET request.`);
                 return res.status(403).json({ msg: 'Forbidden: You do not have access to this project' });
            }
            res.json({ // Return relevant, non-sensitive data
                 projectId: project._id.toString(),
                 name: project.name, // Assumes 'name' field
                 owner: project.owner, // Assumes 'owner' field
                 memberCount: project.members?.length || 0,
             });
        } catch (err) {
            console.error(`Error fetching project ${requestedProjectId}:`, err.message, err.stack);
            res.status(500).send('Server error');
        }
    }
);

// --- GET /api/projects (List projects for user) ---
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const projects = await Project.find({ members: userId }) // Assumes 'members' field
                                      .select('name owner _id createdAt') // Select only needed fields
                                      .sort({ createdAt: -1 }); // Optional: sort by creation date
        res.json(projects);
    } catch (err) {
        console.error("Error fetching user's projects:", err.message, err.stack);
        res.status(500).send('Server error');
    }
});


module.exports = router;